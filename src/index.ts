import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/registry.js";
import { registerAutoTools } from "./tools/auto-register.js";
import { loadCatalog, loadCategories } from "./catalog/repository.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { findProjectRoot } from "./project-root.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = findProjectRoot(__dirname);

/** The published package version, so the MCP handshake reports the truth. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Load .env file manually
function loadEnv(): void {
  // When compiled: dist/src/index.js → need ../../.env to reach project root
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env not found, rely on env vars passed by Claude Desktop/Code
  }
}

async function main(): Promise<void> {
  loadEnv();

  // API tools validate credentials when called. Keeping startup available lets
  // the local discovery tools inspect the bundled catalog before authentication.
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Procore API calls are disabled until PROCORE_CLIENT_ID and " +
        "PROCORE_CLIENT_SECRET are configured. Local discovery tools remain available."
    );
  }

  // Pre-load catalog into memory
  try {
    const catalog = loadCatalog();
    const categories = loadCategories();
    console.error(
      `Catalog loaded: ${catalog.length} endpoints, ${Object.keys(categories.categories).length} categories`
    );
  } catch (err) {
    console.error(
      "ERROR: Failed to load catalog. Run 'npm run build' first.\n" +
        (err as Error).message
    );
    process.exit(1);
  }

  // Create MCP server
  const server = new McpServer({
    name: "procore",
    version: packageVersion(),
  });

  // Register 7 meta/discovery tools
  registerTools(server);

  // Serve the 7 discovery tools by default. Registering one tool per Procore
  // endpoint instead emits roughly 4.7 MB (~1.2M tokens) of tool definitions,
  // which exceeds every current model's context window -- so the full surface
  // is opt-in via PROCORE_TOOL_MODE=all rather than the default. Coverage is
  // unaffected either way: procore_api_call reaches every endpoint.
  let autoCount = 0;
  if ((process.env.PROCORE_TOOL_MODE || "meta").toLowerCase() === "all") {
    autoCount = registerAutoTools(server);
    console.error(`Auto-registered ${autoCount} endpoint tools`);
  } else {
    console.error(
      "Serving the 7 compact meta tools; every Procore endpoint stays reachable " +
        "through procore_api_call. Set PROCORE_TOOL_MODE=all to also register " +
        "a dedicated tool per endpoint."
    );
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Procore MCP server running — ${autoCount + 7} total tools`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
