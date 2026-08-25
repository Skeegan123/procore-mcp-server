import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getValidAccessToken } from "../src/auth/oauth.js";
import { writeTokens } from "../src/auth/token-store.js";
import { runAsUser } from "../src/auth/request-context.js";
import { readUserTokens, writeUserTokens } from "../src/auth/user-token-store.js";

test("concurrent callers share one rotating-token refresh", async (t) => {
  const tokenDir = mkdtempSync(join(tmpdir(), "procore-mcp-refresh-"));
  const previous = {
    clientId: process.env.PROCORE_CLIENT_ID,
    clientSecret: process.env.PROCORE_CLIENT_SECRET,
    tokenPath: process.env.PROCORE_TOKEN_PATH,
  };
  const originalFetch = globalThis.fetch;

  process.env.PROCORE_CLIENT_ID = "client";
  process.env.PROCORE_CLIENT_SECRET = "secret";
  process.env.PROCORE_TOKEN_PATH = join(tokenDir, "tokens.json");
  writeTokens({
    access_token: "expired",
    refresh_token: "refresh-1",
    expires_at: Date.now() - 1,
  });

  let refreshCalls = 0;
  globalThis.fetch = async () => {
    refreshCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(
      JSON.stringify({
        access_token: "fresh",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
        created_at: Math.floor(Date.now() / 1000),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("PROCORE_CLIENT_ID", previous.clientId);
    restoreEnv("PROCORE_CLIENT_SECRET", previous.clientSecret);
    restoreEnv("PROCORE_TOKEN_PATH", previous.tokenPath);
    rmSync(tokenDir, { recursive: true, force: true });
  });

  const tokens = await Promise.all([
    getValidAccessToken(),
    getValidAccessToken(),
    getValidAccessToken(),
  ]);

  assert.deepEqual(tokens, ["fresh", "fresh", "fresh"]);
  assert.equal(refreshCalls, 1);
});

test("concurrent hosted users refresh and persist only their own tokens", async (t) => {
  const tokenDir = mkdtempSync(join(tmpdir(), "procore-mcp-user-refresh-"));
  const previous = {
    clientId: process.env.PROCORE_CLIENT_ID,
    clientSecret: process.env.PROCORE_CLIENT_SECRET,
    userTokenDir: process.env.PROCORE_USER_TOKEN_DIR,
  };
  const originalFetch = globalThis.fetch;

  process.env.PROCORE_CLIENT_ID = "client";
  process.env.PROCORE_CLIENT_SECRET = "secret";
  process.env.PROCORE_USER_TOKEN_DIR = tokenDir;
  writeUserTokens("user-1", {
    access_token: "expired-user-1",
    refresh_token: "refresh-user-1",
    expires_at: Date.now() - 1,
  });
  writeUserTokens("user-2", {
    access_token: "expired-user-2",
    refresh_token: "refresh-user-2",
    expires_at: Date.now() - 1,
  });

  const refreshCalls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const refreshToken = new URLSearchParams(String(init?.body ?? "")).get(
      "refresh_token"
    );
    assert.ok(refreshToken);
    refreshCalls.push(refreshToken);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const user = refreshToken.replace("refresh-", "");
    return new Response(
      JSON.stringify({
        access_token: `fresh-${user}`,
        refresh_token: `rotated-${user}`,
        token_type: "Bearer",
        expires_in: 3600,
        created_at: Math.floor(Date.now() / 1000),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("PROCORE_CLIENT_ID", previous.clientId);
    restoreEnv("PROCORE_CLIENT_SECRET", previous.clientSecret);
    restoreEnv("PROCORE_USER_TOKEN_DIR", previous.userTokenDir);
    rmSync(tokenDir, { recursive: true, force: true });
  });

  const [user1Token, user2Token] = await Promise.all([
    runAsUser("user-1", () => getValidAccessToken()),
    runAsUser("user-2", () => getValidAccessToken()),
  ]);

  assert.deepEqual([user1Token, user2Token], ["fresh-user-1", "fresh-user-2"]);
  assert.deepEqual(refreshCalls.sort(), ["refresh-user-1", "refresh-user-2"]);
  const user1Tokens = readUserTokens("user-1");
  const user2Tokens = readUserTokens("user-2");
  assert.ok(user1Tokens);
  assert.ok(user2Tokens);
  assert.equal(user1Tokens.access_token, "fresh-user-1");
  assert.equal(user1Tokens.refresh_token, "rotated-user-1");
  assert.equal(user2Tokens.access_token, "fresh-user-2");
  assert.equal(user2Tokens.refresh_token, "rotated-user-2");
  assert.notEqual(user1Tokens.access_token, user2Tokens.access_token);
  assert.notEqual(user1Tokens.refresh_token, user2Tokens.refresh_token);
});

test("token refresh has a bounded timeout", async (t) => {
  const tokenDir = mkdtempSync(join(tmpdir(), "procore-mcp-refresh-timeout-"));
  const previous = {
    clientId: process.env.PROCORE_CLIENT_ID,
    clientSecret: process.env.PROCORE_CLIENT_SECRET,
    tokenPath: process.env.PROCORE_TOKEN_PATH,
    authTimeout: process.env.PROCORE_AUTH_TIMEOUT_MS,
  };
  const originalFetch = globalThis.fetch;

  process.env.PROCORE_CLIENT_ID = "client";
  process.env.PROCORE_CLIENT_SECRET = "secret";
  process.env.PROCORE_TOKEN_PATH = join(tokenDir, "tokens.json");
  process.env.PROCORE_AUTH_TIMEOUT_MS = "5";
  writeTokens({
    access_token: "expired",
    refresh_token: "refresh-1",
    expires_at: Date.now() - 1,
  });

  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason || new Error("aborted"));
      });
    });

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("PROCORE_CLIENT_ID", previous.clientId);
    restoreEnv("PROCORE_CLIENT_SECRET", previous.clientSecret);
    restoreEnv("PROCORE_TOKEN_PATH", previous.tokenPath);
    restoreEnv("PROCORE_AUTH_TIMEOUT_MS", previous.authTimeout);
    rmSync(tokenDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () => getValidAccessToken(50),
    /OAuth request timed out after 5ms/
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
