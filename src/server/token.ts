import { claimsSchema, type Claims, type Grant, type Role } from "../shared/protocol";

/** Access tokens are EdDSA JWTs, one key pair per role; `kid` names the role. The public key is never in a token. */

type RoleKeys = {
  publicKey: string;
  signKey: CryptoKey;
  verifyKey: CryptoKey;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<RoleKeys>>();

export class TokenError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TokenError";
  }
}

function privateKeyFor(env: Env, role: Role): string {
  const value = role === "device" ? env.DEVICE_PRIVATE_KEY : env.VIEWER_PRIVATE_KEY;
  if (!value?.trim()) {
    throw new TokenError("key_not_configured", `${role.toUpperCase()}_PRIVATE_KEY is not set.`);
  }
  return value.trim();
}

/** Imports a base64url PKCS#8 Ed25519 private key and derives its public key. */
function loadKeys(env: Env, role: Role): Promise<RoleKeys> {
  const secret = privateKeyFor(env, role);
  let keys = keyCache.get(secret);
  if (!keys) {
    keys = (async () => {
      const signKey = await crypto.subtle.importKey(
        "pkcs8",
        base64UrlDecode(secret),
        { name: "Ed25519" },
        true,
        ["sign"],
      );
      const jwk = (await crypto.subtle.exportKey("jwk", signKey)) as JsonWebKey;
      if (!jwk.x) throw new TokenError("key_invalid", "The private key has no public part.");
      const verifyKey = await crypto.subtle.importKey(
        "raw",
        base64UrlDecode(jwk.x),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return { publicKey: jwk.x, signKey, verifyKey };
    })();
    keyCache.set(secret, keys);
    // A bad secret should not stay cached as a rejected promise.
    keys.catch(() => keyCache.delete(secret));
  }
  return keys;
}

/** Returns which role a bearer public key belongs to, or null. */
export async function roleForPublicKey(env: Env, bearer: string): Promise<Role | null> {
  for (const role of ["device", "viewer"] as const) {
    const { publicKey } = await loadKeys(env, role);
    if (timingSafeEqual(bearer, publicKey)) return role;
  }
  return null;
}

export async function signToken(
  env: Env,
  role: Role,
  sub: string,
  grant: Grant,
  ttlSec: number,
): Promise<string> {
  const { signKey } = await loadKeys(env, role);
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: role };
  const claims: Claims = { sub, jti: crypto.randomUUID(), iat, exp: iat + ttlSec, grant };
  const input = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, signKey, encoder.encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Checks the signature, the role and the expiry. The target DO checks single use. */
export async function verifyToken(env: Env, token: string): Promise<{ role: Role; claims: Claims }> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 4096) {
    throw new TokenError("token_invalid", "The access token is malformed.");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let payload: unknown;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerPart)));
    payload = JSON.parse(decoder.decode(base64UrlDecode(payloadPart)));
  } catch {
    throw new TokenError("token_invalid", "The access token is malformed.");
  }
  if (header.alg !== "EdDSA" || (header.kid !== "device" && header.kid !== "viewer")) {
    throw new TokenError("token_invalid", "The access token uses an unknown key.");
  }
  const role: Role = header.kid;
  const { verifyKey } = await loadKeys(env, role);
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    verifyKey,
    base64UrlDecode(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new TokenError("token_invalid", "The access token signature is not valid.");

  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) throw new TokenError("token_invalid", "The access token claims are not valid.");
  const claims = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new TokenError("token_expired", "The access token has expired.");
  if (claims.grant.canSubscribe !== (role === "viewer") || claims.grant.canPublish !== (role === "device")) {
    throw new TokenError("token_invalid", "The access token grant does not match its key.");
  }
  return { role, claims };
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/** Tokens carry the secret's SHA-256 (base64url), not the secret. */
export async function hashSecret(secret: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret))));
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TokenError("token_invalid", "Bad base64url.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
