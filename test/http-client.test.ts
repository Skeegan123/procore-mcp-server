import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcoreHttpError,
  procoreApiCall,
} from "../src/api/client.js";
import { handleApiCall } from "../src/tools/handlers/api-call.js";

const tokenPath = join(tmpdir(), `procore-mcp-http-client-${process.pid}.json`);
const originalFetch = globalThis.fetch;
const originalEnv = {
  tokenPath: process.env.PROCORE_TOKEN_PATH,
  clientId: process.env.PROCORE_CLIENT_ID,
  clientSecret: process.env.PROCORE_CLIENT_SECRET,
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
  process.env.PROCORE_CLIENT_ID = "test-client";
  process.env.PROCORE_CLIENT_SECRET = "test-secret";
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.tokenPath === undefined) delete process.env.PROCORE_TOKEN_PATH;
  else process.env.PROCORE_TOKEN_PATH = originalEnv.tokenPath;
  if (originalEnv.clientId === undefined) delete process.env.PROCORE_CLIENT_ID;
  else process.env.PROCORE_CLIENT_ID = originalEnv.clientId;
  if (originalEnv.clientSecret === undefined) delete process.env.PROCORE_CLIENT_SECRET;
  else process.env.PROCORE_CLIENT_SECRET = originalEnv.clientSecret;
  unlinkSync(tokenPath);
});

function baseOptions(method: string, body?: Record<string, unknown>) {
  return {
    method,
    path: "/rest/v1.0/test",
    body,
    timeoutMs: 100,
  };
}

test("multipart requests use FormData and a JSON-safe file descriptor", async () => {
  let requestInit: RequestInit | undefined;
  let wireRequest: Request | undefined;
  globalThis.fetch = async (input, init) => {
    requestInit = init;
    wireRequest = new Request(input, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const response = await procoreApiCall({
    ...baseOptions("POST", {
      record: { name: "Daily log" },
      attachment: {
        base64: Buffer.from("hello").toString("base64"),
        filename: "hello.txt",
        contentType: "text/plain",
      },
      attachments: [
        {
          base64: Buffer.from("world").toString("base64"),
          filename: "world.txt",
          contentType: "text/plain",
        },
      ],
    }),
    contentType: "multipart/form-data",
  });

  assert.deepEqual(response.data, { ok: true });
  assert.ok(requestInit?.body instanceof FormData);
  assert.equal(
    (requestInit?.headers as Record<string, string>)["Content-Type"],
    undefined,
    "fetch must generate the multipart boundary"
  );
  assert.match(
    wireRequest?.headers.get("content-type") || "",
    /^multipart\/form-data; boundary=/
  );
  const form = requestInit?.body as FormData;
  assert.equal(form.get("record[name]"), "Daily log");
  const attachment = form.get("attachment");
  assert.ok(attachment instanceof Blob);
  assert.equal(await (attachment as Blob).text(), "hello");
  assert.equal((attachment as File).name, "hello.txt");
  const attachments = form.getAll("attachments[]");
  assert.equal(attachments.length, 1);
  assert.equal(await (attachments[0] as Blob).text(), "world");
});

test("JSON and merge-patch requests keep their declared content type", async () => {
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return new Response(null, { status: 204 });
  };

  await procoreApiCall({
    ...baseOptions("PATCH", { record: { enabled: true } }),
    contentType: "application/merge-patch+json",
  });

  assert.equal(
    (requestInit?.headers as Record<string, string>)["Content-Type"],
    "application/merge-patch+json"
  );
  assert.equal(requestInit?.body, JSON.stringify({ record: { enabled: true } }));
});

test("network failures do not retry non-idempotent methods", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("connection reset");
    };

    await assert.rejects(
      () => procoreApiCall(baseOptions(method, { record: { name: "once" } })),
      /connection reset/
    );
    assert.equal(calls, 1, `${method} must not retry`);
  }
});

test("5xx responses do not retry non-idempotent requests", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: "temporary failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    () => procoreApiCall(baseOptions("POST", { record: { name: "once" } })),
    (error: unknown) =>
      error instanceof ProcoreHttpError &&
      error.status === 503 &&
      error.message.includes("temporary failure")
  );
  assert.equal(calls, 1);
});

test("requests have a finite abort timeout", async () => {
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

  await assert.rejects(
    () => procoreApiCall({ ...baseOptions("POST"), timeoutMs: 5 }),
    /timed out after 5ms/
  );
});

test("binary responses return bounded base64 metadata", async () => {
  const bytes = new Uint8Array(40_000).fill(65);
  globalThis.fetch = async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
      },
    });

  const response = await procoreApiCall(baseOptions("GET"));
  assert.deepEqual(
    response.data && typeof response.data === "object"
      ? {
          kind: (response.data as Record<string, unknown>).kind,
          content_type: (response.data as Record<string, unknown>).content_type,
          encoding: (response.data as Record<string, unknown>).encoding,
          bytes: (response.data as Record<string, unknown>).bytes,
          total_bytes: (response.data as Record<string, unknown>).total_bytes,
          truncated: (response.data as Record<string, unknown>).truncated,
          base64Length: String((response.data as Record<string, unknown>).data).length,
        }
      : response.data,
    {
      kind: "binary",
      content_type: "application/pdf",
      encoding: "base64",
      bytes: 32 * 1024,
      total_bytes: 40_000,
      truncated: true,
      base64Length: 43_692,
    }
  );
});

test("generic MCP handler forwards multipart content type and marks errors", async () => {
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const success = await handleApiCall({
    method: "POST",
    path: "/rest/v1.0/test",
    content_type: "multipart/form-data",
    body: {
      attachment: {
        base64: Buffer.from("handler").toString("base64"),
        filename: "handler.txt",
        contentType: "text/plain",
      },
    },
  });
  assert.equal(success.isError, false);
  assert.match(request?.headers.get("content-type") || "", /^multipart\/form-data; boundary=/);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "denied" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  const failure = await handleApiCall({
    method: "GET",
    path: "/rest/v1.0/test",
  });
  assert.equal(failure.isError, true);
  assert.match(failure.text, /HTTP 403: denied/);
});

test("multipart input rejects malformed base64 before fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };

  await assert.rejects(
    () =>
      procoreApiCall({
        ...baseOptions("POST", { attachment: { base64: "A=" } }),
        contentType: "multipart/form-data",
      }),
    /canonical base64/
  );
  assert.equal(calls, 0);
});
