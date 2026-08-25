import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer as createProbeServer } from "node:http";

process.env.PROCORE_MCP_TOKEN_SECRET = "test-secret-for-http-server";
process.env.PROCORE_OAUTH_REDIRECT_URIS = "https://client.example/callback";
delete process.env.PROCORE_ALLOW_ANY_REDIRECT;
process.env.PROCORE_CLIENT_ID = "test-client-id";
process.env.PROCORE_CLIENT_SECRET = "test-client-secret";
process.env.PROCORE_READ_ONLY = "";

let server: ReturnType<typeof import("../src/http-server.js").startHttpServer>;
let base = "";
const { startHttpServer } = await import("../src/http-server.js");
const { issueAccessToken } = await import("../src/auth/hosted-auth.js");

before(async () => {
  // Pick a free port first so PROCORE_MCP_BASE_URL matches the listener.
  const probe = createProbeServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(resolve));

  process.env.PORT = String(port);
  process.env.PROCORE_MCP_BASE_URL = `http://localhost:${port}`;
  server = startHttpServer();
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  base = `http://localhost:${port}`;
});

after(() => {
  server.close();
});

test("healthz reports liveness and read-only state", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; read_only: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.read_only, true);
});

test("protected resource metadata points at the local authorization server", async () => {
  const res = await fetch(
    `${base}/.well-known/oauth-protected-resource`
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    resource: string;
    authorization_servers: string[];
  };
  assert.equal(body.resource, `${base}/mcp`);
  assert.deepEqual(body.authorization_servers, [base]);
});

test("authorization server metadata advertises code + S256 only", async () => {
  const res = await fetch(
    `${base}/.well-known/oauth-authorization-server`
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    code_challenge_methods_supported: string[];
  };
  assert.equal(body.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${base}/oauth/token`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
});

test("/mcp rejects unauthenticated requests with a challenge", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST" });
  assert.equal(res.status, 401);
  const wwwAuth = res.headers.get("www-authenticate") || "";
  assert.match(wwwAuth, /Bearer/);
  assert.match(wwwAuth, /resource_metadata/);
});

test("/mcp rejects a forged bearer token", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.equal(res.status, 401);
});

test("a valid access token passes auth and reaches the MCP handler", async () => {
  const { token } = issueAccessToken("smoke-user", 3600);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.0.0" },
      },
    }),
  });
  assert.notEqual(res.status, 401);
  assert.ok(res.ok, `expected success, got ${res.status}`);
});

test("/oauth/authorize redirects to Procore for allowlisted redirect URIs", async () => {
  const res = await fetch(
    `${base}/oauth/authorize?response_type=code&client_id=chatgpt&redirect_uri=${encodeURIComponent(
      "https://client.example/callback"
    )}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=abc`,
    { redirect: "manual" }
  );
  assert.equal(res.status, 302);
  const location = res.headers.get("location") || "";
  assert.match(location, /^https:\/\/login(-sandbox)?\.procore\.com\/oauth\/authorize/);
  assert.match(location, /redirect_uri=%7B?http|%22?/); // our callback is embedded
  assert.match(new URL(location).searchParams.get("redirect_uri") || "", /\/oauth\/callback$/);
});

test("/oauth/authorize rejects redirect URIs that are not allowlisted", async () => {
  const res = await fetch(
    `${base}/oauth/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(
      "https://evil.example/cb"
    )}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
    { redirect: "manual" }
  );
  assert.equal(res.status, 400);
});

test("/oauth/token requires POST", async () => {
  const res = await fetch(`${base}/oauth/token`);
  assert.equal(res.status, 405);
});
