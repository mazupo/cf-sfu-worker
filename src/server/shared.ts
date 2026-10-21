import { claimsSchema, type Claims } from "../shared/protocol";
import { CLAIMS_HEADER } from "./socket";

/** The claims the Worker verified. Only the Worker reaches a Durable Object's fetch. */
export function claimsFromRequest(request: Request): Claims | null {
  const header = request.headers.get(CLAIMS_HEADER);
  if (!header) return null;
  try {
    const parsed = claimsSchema.safeParse(JSON.parse(decodeURIComponent(header)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Marks a token as used, or returns false if it was. Each DO keeps the ids until they expire. */
export function useToken(sql: SqlStorage, claims: Claims, now: number): boolean {
  sql.exec("DELETE FROM used_tokens WHERE expires_at <= ?", now);
  const seen = sql.exec("SELECT 1 FROM used_tokens WHERE jti = ?", claims.jti).toArray().length > 0;
  if (seen) return false;
  sql.exec("INSERT INTO used_tokens (jti, expires_at) VALUES (?, ?)", claims.jti, claims.exp * 1000 + 60_000);
  return true;
}

export function tableExists(sql: SqlStorage, name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}
