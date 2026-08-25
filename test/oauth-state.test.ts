import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOAuthAuthorizationUrl,
  createOAuthState,
  isValidOAuthState,
} from "../src/auth/oauth-state.js";

test("OAuth state is random and validates only an exact match", () => {
  const first = createOAuthState();
  const second = createOAuthState();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(isValidOAuthState(first, first), true);
  assert.equal(isValidOAuthState(first, second), false);
  assert.equal(isValidOAuthState(first, null), false);
  assert.equal(isValidOAuthState(first, `${first}x`), false);
});

test("authorization URL carries the exact redirect URI and OAuth state", () => {
  const url = new URL(
    buildOAuthAuthorizationUrl(
      "https://login.procore.com",
      "client id",
      "http://localhost",
      "state-value"
    )
  );

  assert.equal(url.origin, "https://login.procore.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost");
  assert.equal(url.searchParams.get("state"), "state-value");
});
