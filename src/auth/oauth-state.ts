import { randomBytes, timingSafeEqual } from "crypto";

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildOAuthAuthorizationUrl(
  authBase: string,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL("/oauth/authorize", authBase);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

export function isValidOAuthState(
  expected: string,
  received: string | null
): boolean {
  if (!received) return false;

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  if (expectedBytes.length !== receivedBytes.length) return false;

  return timingSafeEqual(expectedBytes, receivedBytes);
}
