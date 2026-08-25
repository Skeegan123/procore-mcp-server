import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

test("local meta tools start without Procore credentials or tokens", async (t) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    })
  );
  env.PROCORE_CLIENT_ID = "";
  env.PROCORE_CLIENT_SECRET = "";
  env.PROCORE_TOKEN_PATH = resolve(root, ".missing-test-tokens.json");
  env.PROCORE_TOOL_MODE = "meta";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "startup-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });

  await client.connect(transport);
  const result = await client.listTools();
  assert.equal(result.tools.length, 7);
  assert.ok(result.tools.some((tool) => tool.name === "procore_discover_categories"));
  assert.ok(result.tools.some((tool) => tool.name === "procore_api_call"));
});
