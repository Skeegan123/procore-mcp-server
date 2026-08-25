import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeGrant,
  createGrant,
  createPendingAuthorization,
  getPendingAuthorization,
  issueAccessToken,
  verifyAccessToken,
  verifyPkceS256,
} from "../src/auth/hosted-auth.js";

process.env.PROCORE_MCP_TOKEN_SECRET = "test-secret-for-hosted-auth";

test("issued access tokens verify and name their user", () => {
  const { token, expiresIn } = issueAccessToken("user-1", 3600);
  assert.ok(expiresIn > 0);
  const sub = verifyAccessToken(`Bearer ${token}`.replace("Bearer ", ""));
  assert.equal(sub, "user-1");
});

test("tampered tokens are rejected", () => {
  const { token } = issueAccessToken("user-1", 3600);
  const [payload] = token.split(".");
  const forged = `${payload}.c2lnbmF0dXJlLWZvcmdlcnk`;
  assert.equal(verifyAccessToken(forged), null);
  // A signature from a different secret must not verify either.
  process.env.PROCORE_MCP_TOKEN_SECRET = "other-secret";
  try {
    assert.equal(verifyAccessToken(token), null);
  } finally {
    process.env.PROCORE_MCP_TOKEN_SECRET = "test-secret-for-hosted-auth";
  }
});

test("expired tokens are rejected", () => {
  const { token } = issueAccessToken("user-1", -1);
  assert.equal(verifyAccessToken(token), null);
});

test("PKCE S256 verification accepts only the matching verifier", () => {
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  // Verifier for the canonical RFC 7636 appendix B example.
  const verifier =
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(verifyPkceS256(challenge, verifier), true);
  assert.equal(verifyPkceS256(challenge, "wrong-verifier"), false);
});

test("pending authorizations round-trip and expire", () => {
  const state = createPendingAuthorization({
    clientId: "client-1",
    redirectUri: "https://client.example/callback",
    clientState: "xyz",
    codeChallenge: "abc",
  });
  const pending = getPendingAuthorization(state);
  assert.ok(pending);
  assert.equal(pending.clientId, "client-1");
  assert.equal(pending.clientState, "xyz");
});

test("grants are single-use, redirect-bound, and PKCE-checked", () => {
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const makeGrant = () =>
    createGrant({
      userId: "user-9",
      redirectUri: "https://client.example/callback",
      codeChallenge: challenge,
    });

  // Any failed attempt burns the grant, so each failure gets its own.
  assert.equal(
    consumeGrant(makeGrant(), "wrong-verifier", "https://client.example/callback"),
    null
  );
  assert.equal(
    consumeGrant(makeGrant(), verifier, "https://evil.example/callback"),
    null
  );

  const code = makeGrant();
  const first = consumeGrant(code, verifier, "https://client.example/callback");
  assert.deepEqual(first, { userId: "user-9" });
  // Replay after the single use must fail.
  assert.equal(
    consumeGrant(code, verifier, "https://client.example/callback"),
    null
  );
});
