import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGetConfig } from "../src/tools/handlers/get-config.js";
import { handleSetConfig } from "../src/tools/handlers/set-config.js";
import {
  getRuntimeConfig,
  clearRuntimeConfig,
  procoreApiCall,
  setRuntimeConfig,
} from "../src/api/client.js";
import { runAsUser } from "../src/auth/request-context.js";
import { writeUserTokens } from "../src/auth/user-token-store.js";

const originalFetch = globalThis.fetch;
const originalTokenPath = process.env.PROCORE_TOKEN_PATH;
const originalCompanyId = process.env.PROCORE_COMPANY_ID;
const originalUserTokenDir = process.env.PROCORE_USER_TOKEN_DIR;
const tokenDirectory = mkdtempSync(join(tmpdir(), "procore-runtime-config-"));
const tokenPath = join(tokenDirectory, "tokens.json");
const userTokenDirectory = join(tokenDirectory, "users");
const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const testUserKeys = ["runtime-config-user-a", "runtime-config-user-b"];

beforeEach(() => {
  clearRuntimeConfig();
  fetchCalls.length = 0;
  process.env.PROCORE_TOKEN_PATH = tokenPath;
  process.env.PROCORE_USER_TOKEN_DIR = userTokenDirectory;
  process.env.PROCORE_COMPANY_ID = "456";
  mkdirSync(tokenDirectory, { recursive: true });
  const tokens = {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Date.now() + 60 * 60 * 1000,
  };
  writeFileSync(tokenPath, JSON.stringify(tokens));
  for (const userKey of testUserKeys) writeUserTokens(userKey, tokens);
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  // clearRuntimeConfig is deliberately scoped to the current request user.
  // Reset every test user explicitly so a failed test cannot affect a later
  // test while preserving the production isolation semantics.
  for (const userKey of testUserKeys) {
    runAsUser(userKey, () => clearRuntimeConfig());
  }
});

after(() => {
  clearRuntimeConfig();
  globalThis.fetch = originalFetch;
  restoreEnv("PROCORE_TOKEN_PATH", originalTokenPath);
  restoreEnv("PROCORE_USER_TOKEN_DIR", originalUserTokenDir);
  restoreEnv("PROCORE_COMPANY_ID", originalCompanyId);
  rmSync(tokenDirectory, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requestUrl(): string {
  assert.equal(fetchCalls.length, 1);
  return String(fetchCalls[0].input);
}

function requestHeaders(): Record<string, string> {
  const headers = fetchCalls[0].init?.headers;
  assert.ok(headers && !Array.isArray(headers));
  return headers as Record<string, string>;
}

test("runtime company/project IDs fill placeholders and override env company", async () => {
  await handleSetConfig({ key: "company_id", value: "123" });
  await handleSetConfig({ key: "project_id", value: "4567" });

  await procoreApiCall({
    method: "GET",
    path: "/rest/v1.0/companies/{company_id}/projects/{project_id}/rfis",
  });

  assert.equal(
    requestUrl(),
    "https://api.procore.com/rest/v1.0/companies/123/projects/4567/rfis"
  );
  assert.equal(requestHeaders()["Procore-Company-Id"], "123");
});

test("explicit path params and per-call company ID take precedence", async () => {
  await handleSetConfig({ key: "company_id", value: "123" });
  await handleSetConfig({ key: "project_id", value: "4567" });

  await procoreApiCall({
    method: "GET",
    path: "/rest/v1.0/companies/{company_id}/projects/{project_id}/rfis",
    pathParams: { company_id: "789", project_id: "9876" },
    companyId: 321,
  });

  assert.equal(
    requestUrl(),
    "https://api.procore.com/rest/v1.0/companies/789/projects/9876/rfis"
  );
  assert.equal(requestHeaders()["Procore-Company-Id"], "321");
});

test("unresolved placeholders fail before fetch", async () => {
  await assert.rejects(
    procoreApiCall({
      method: "GET",
      path: "/rest/v1.0/projects/{missing_project}/rfis",
    }),
    /Unresolved path parameter.*\{missing_project\}/
  );
  assert.equal(fetchCalls.length, 0);
});

test("runtime ID values reject partial, non-positive, and unsafe integers", async () => {
  await handleSetConfig({ key: "company_id", value: "123" });
  const before = getRuntimeConfig();
  const invalidValues = ["12x", "0", "-1", "9007199254740992", "1.2"];

  for (const value of invalidValues) {
    const result = await handleSetConfig({ key: "company_id", value });
    assert.match(result, /must be a positive safe integer/);
    assert.deepEqual(getRuntimeConfig(), before);
  }

  assert.throws(
    () => setRuntimeConfig("project_id", "9007199254740993"),
    /must be a positive safe integer/
  );
});

test("get_config identifies process-local runtime overrides", async () => {
  await handleSetConfig({ key: "company_id", value: "123" });
  await handleSetConfig({ key: "project_id", value: "4567" });

  const config = await handleGetConfig();
  assert.match(config, /Default Company ID: 123/);
  assert.match(config, /Company ID source: runtime override \(process-local\)/);
  assert.match(config, /Default Project ID: 4567/);
  assert.match(config, /apply only to this server process and are lost on restart/);
});

test("hosted runtime defaults are isolated per authenticated user", async () => {
  await runAsUser(testUserKeys[0], async () => {
    await handleSetConfig({ key: "company_id", value: "111" });
    await handleSetConfig({ key: "project_id", value: "222" });

    await procoreApiCall({
      method: "GET",
      path: "/rest/v1.0/companies/{company_id}/projects/{project_id}/rfis",
    });
    assert.equal(
      requestUrl(),
      "https://api.procore.com/rest/v1.0/companies/111/projects/222/rfis"
    );
    assert.equal(requestHeaders()["Procore-Company-Id"], "111");
  });

  fetchCalls.length = 0;
  await runAsUser(testUserKeys[1], async () => {
    assert.deepEqual(getRuntimeConfig(), {});
    await handleSetConfig({ key: "company_id", value: "333" });
    await handleSetConfig({ key: "project_id", value: "444" });

    await procoreApiCall({
      method: "GET",
      path: "/rest/v1.0/companies/{company_id}/projects/{project_id}/rfis",
    });
    assert.equal(
      requestUrl(),
      "https://api.procore.com/rest/v1.0/companies/333/projects/444/rfis"
    );
    assert.equal(requestHeaders()["Procore-Company-Id"], "333");
  });

  await runAsUser(testUserKeys[0], () => {
    assert.deepEqual(getRuntimeConfig(), { company_id: 111, project_id: 222 });
  });
});

test("no request context keeps the legacy process-local runtime defaults", async () => {
  await handleSetConfig({ key: "company_id", value: "555" });
  await handleSetConfig({ key: "project_id", value: "666" });

  assert.deepEqual(getRuntimeConfig(), { company_id: 555, project_id: 666 });
  await runAsUser(testUserKeys[0], () => {
    assert.deepEqual(getRuntimeConfig(), {});
  });
});
