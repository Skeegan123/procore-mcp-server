import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Auth plumbing for hosted mode. The server acts as a thin OAuth layer in
 * front of Procore: an MCP client (ChatGPT connector, Claude, etc.) performs
 * a standard authorization-code + PKCE flow against this server, each leg of
 * which signs the user into Procore itself. The result is a short-lived,
 * self-verifying access token that names the user whose Procore tokens serve
 * every subsequent MCP call.
 *
 * Pending authorizations and one-time grants live in memory with short TTLs.
 * That keeps a single-instance deployment dependency-free; multi-instance or
 * serverless deployments should move these maps behind Redis/DynamoDB (they
 * are deliberately tiny interfaces).
 */

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  expiresAt: number;
}

export interface AuthorizationGrant {
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 5 * 60_000;

const pendingAuthorizations = new Map<string, PendingAuthorization>();
const grants = new Map<string, AuthorizationGrant>();

let ephemeralSecret: string | null = null;

function signingSecret(): string {
  const fromEnv = process.env.PROCORE_MCP_TOKEN_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (!ephemeralSecret) {
    console.error(
      "WARNING: PROCORE_MCP_TOKEN_SECRET is not set. Access tokens are signed " +
        "with an ephemeral key and stop working when the process restarts."
    );
    ephemeralSecret = randomBytes(32).toString("hex");
  }
  return ephemeralSecret;
}

function hmac(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function getDefaultAccessTokenTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.PROCORE_MCP_ACCESS_TOKEN_TTL || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 24 * 3600;
}

/** Issues a self-verifying bearer token naming the user it was issued to. */
export function issueAccessToken(userId: string, ttlSeconds?: number): {
  token: string;
  expiresIn: number;
} {
  const expiresIn = ttlSeconds ?? getDefaultAccessTokenTtlSeconds();
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Date.now() + expiresIn * 1000 })
  ).toString("base64url");
  return { token: `${payload}.${hmac(payload)}`, expiresIn };
}

/** Returns the user id for a valid, unexpired token; null otherwise. */
export function verifyAccessToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = hmac(payload);
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(signature);
  if (expectedBytes.length !== receivedBytes.length) return null;
  if (!timingSafeEqual(expectedBytes, receivedBytes)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.sub !== "string" || typeof decoded.exp !== "number") return null;
    if (Date.now() >= decoded.exp) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}

export function verifyPkceS256(challenge: string, verifier: string): boolean {
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const expectedBytes = Buffer.from(computed);
  const receivedBytes = Buffer.from(challenge);
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

export function createPendingAuthorization(input: Omit<PendingAuthorization, "expiresAt">): string {
  const state = randomBytes(32).toString("base64url");
  pendingAuthorizations.set(state, { ...input, expiresAt: Date.now() + PENDING_TTL_MS });
  sweep();
  return state;
}

export function getPendingAuthorization(state: string): PendingAuthorization | null {
  const pending = pendingAuthorizations.get(state);
  if (!pending || Date.now() >= pending.expiresAt) {
    pendingAuthorizations.delete(state);
    return null;
  }
  return pending;
}

export function deletePendingAuthorization(state: string): void {
  pendingAuthorizations.delete(state);
}

export function createGrant(input: Omit<AuthorizationGrant, "expiresAt">): string {
  const code = randomBytes(32).toString("base64url");
  grants.set(code, { ...input, expiresAt: Date.now() + GRANT_TTL_MS });
  sweep();
  return code;
}

/**
 * Single-use exchange: validates the code, its bound redirect URI, and the
 * PKCE verifier, then burns the grant so it can never be replayed.
 */
export function consumeGrant(
  code: string,
  verifier: string,
  redirectUri: string
): { userId: string } | null {
  const grant = grants.get(code);
  if (!grant || Date.now() >= grant.expiresAt) {
    grants.delete(code);
    return null;
  }
  grants.delete(code);
  if (grant.redirectUri !== redirectUri) return null;
  if (!verifyPkceS256(grant.codeChallenge, verifier)) return null;
  return { userId: grant.userId };
}

function sweep(): void {
  const now = Date.now();
  for (const [key, value] of pendingAuthorizations) {
    if (now >= value.expiresAt) pendingAuthorizations.delete(key);
  }
  for (const [key, value] of grants) {
    if (now >= value.expiresAt) grants.delete(key);
  }
}
