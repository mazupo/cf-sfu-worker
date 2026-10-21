import { createRemoteJWKSet, jwtVerify } from "jose";

/** Who Cloudflare Access let in. */
export type AccessIdentity = { email: string | null };

export type AccessSettings = { issuer: string; audience: string };

/** Access guards the dashboard when ACCESS_TEAM_DOMAIN and ACCESS_AUD are both set. */
export function accessSettings(env: Env): AccessSettings | null {
  const domain = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const audience = String(env.ACCESS_AUD ?? "").trim();
  if (!domain || !audience) return null;
  return { issuer: domain.startsWith("https://") ? domain : `https://${domain}`, audience };
}

// One key set per team. jose fetches the keys again when Access rotates them.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Checks the Cf-Access-Jwt-Assertion JWT itself: the worker may answer on hosts Access does not cover. */
export async function verifyAccess(token: string, settings: AccessSettings): Promise<AccessIdentity | null> {
  if (!token) return null;
  let keys = keySets.get(settings.issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${settings.issuer}/cdn-cgi/access/certs`));
    keySets.set(settings.issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: settings.issuer, audience: settings.audience });
    return { email: typeof payload.email === "string" ? payload.email : null };
  } catch {
    return null;
  }
}
