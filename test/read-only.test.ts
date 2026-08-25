import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procoreApiCall } from "../src/api/client.js";
import {
  isReadOnlyMode,
  readOnlyRejectionMessage,
} from "../src/api/read-only.js";
import {
  discoverEndpoints,
  getEndpointByOperationId,
  getEndpointDetails,
  searchEndpoints,
} from "../src/catalog/service.js";

const tokenPath = join(tmpdir(), `procore-mcp-read-only-${process.pid}.json`);
const originalFetch = globalThis.fetch;
const originalEnv = {
  tokenPath: process.env.PROCORE_TOKEN_PATH,
  readOnly: process.env.PROCORE_READ_ONLY,
};

before(() => {
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: "test-token",
      refresh_token: "test-refresh-token",
      expires_at: Date.now() + 3_600_000,
    })
  );
  process.env.PROCORE_TOKEN_PATH = tokenPath;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.tokenPath === undefined) delete process.env.PROCORE_TOKEN_PATH;
  else process.env.PROCORE_TOKEN_PATH = originalEnv.tokenPath;
  if (originalEnv.readOnly === undefined) delete process.env.PROCORE_READ_ONLY;
  else process.env.PROCORE_READ_ONLY = originalEnv.readOnly;
  unlinkSync(tokenPath);
});

let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

test("read-only mode is on by default", () => {
  delete process.env.PROCORE_READ_ONLY;
  assert.equal(isReadOnlyMode(), true);
});

test("PROCORE_READ_ONLY=false and equivalents disable read-only mode", () => {
  for (const value of ["false", "0", "no", "off", "FALSE", " Off "]) {
    process.env.PROCORE_READ_ONLY = value;
    assert.equal(isReadOnlyMode(), false, `value: ${value}`);
  }
  for (const value of ["true", "1", "yes", "", "anything"]) {
    process.env.PROCORE_READ_ONLY = value;
    assert.equal(isReadOnlyMode(), true, `value: "${value}"`);
  }
});

test("non-GET methods are rejected before any auth or network work", async () => {
  delete process.env.PROCORE_READ_ONLY;

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await assert.rejects(
      procoreApiCall({ method, path: "/rest/v1.0/test" }),
      (err: Error) => {
        assert.match(err.message, /writes are guarded/);
        assert.match(err.message, new RegExp(method));
        return true;
      }
    );
  }
  assert.equal(fetchCalls, 0);
});

test("lowercase non-GET methods are rejected too", async () => {
  delete process.env.PROCORE_READ_ONLY;
  await assert.rejects(
    procoreApiCall({ method: "post", path: "/rest/v1.0/test" }),
    (err: Error) => {
      assert.equal(err.message, readOnlyRejectionMessage("post"));
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("GET requests still work in read-only mode", async () => {
  delete process.env.PROCORE_READ_ONLY;
  const response = await procoreApiCall({
    method: "GET",
    path: "/rest/v1.0/test",
  });
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
});

test("writes go through when PROCORE_READ_ONLY=false", async () => {
  process.env.PROCORE_READ_ONLY = "false";
  const response = await procoreApiCall({
    method: "POST",
    path: "/rest/v1.0/test",
    body: { name: "x" },
  });
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
});

test("discovery hides non-GET endpoints in read-only mode", () => {
  process.env.PROCORE_READ_ONLY = "false";
  const all = discoverEndpoints({});
  assert.ok(all.some((e) => e.method !== "GET"));

  delete process.env.PROCORE_READ_ONLY;
  const visible = discoverEndpoints({});
  assert.ok(visible.length > 0);
  assert.ok(visible.every((e) => e.method === "GET"));
});

test("search results are GET-only in read-only mode", () => {
  delete process.env.PROCORE_READ_ONLY;
  // A term that matches both reads and writes in the bundled catalog.
  const results = searchEndpoints("workflow");
  assert.ok(results.length > 0);
  assert.ok(results.every((e) => e.method === "GET"));
});

test("write endpoint details and lookups are hidden in read-only mode", () => {
  delete process.env.PROCORE_READ_ONLY;
  const writeId = "RestV20CompaniesCompanyIdProjectsProjectIdWorkflowsInstancesPost";

  assert.equal(getEndpointByOperationId(writeId), undefined);
  assert.equal(getEndpointDetails(writeId), null);

  // With read-only off, the same lookup succeeds.
  process.env.PROCORE_READ_ONLY = "false";
  assert.notEqual(getEndpointByOperationId(writeId), undefined);
  assert.notEqual(getEndpointDetails(writeId), null);
});
