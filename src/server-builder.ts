import { McpServer } from "@modelcontextprotocol/server";
import { loadCatalog, loadCategories } from "./catalog/repository.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { findProjectRoot } from "./project-root.js";
import { isReadOnlyMode } from "./api/read-only.js";
import { registerTools } from "./tools/registry.js";
import { registerAutoTools } from "./tools/auto-register.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = findProjectRoot(__dirname);

/** Loads ./.env from the project root without overriding real env vars. */
export function loadEnvFile(): void {
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
    // .env not found; rely on environment variables
  }
}

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

export function logStartupContext(): void {
  if (isReadOnlyMode()) {
    console.error(
      "Read-only mode is ON: only GET requests are served. Set PROCORE_READ_ONLY=false to enable writes."
    );
  }

  // API tools validate credentials when called. Keeping startup available lets
  // local discovery tools inspect the bundled catalog before authentication.
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Procore API calls are disabled until PROCORE_CLIENT_ID and " +
        "PROCORE_CLIENT_SECRET are configured. Local discovery tools remain available."
    );
  }
}

export function ensureCatalogLoaded(): void {
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
}

/**
 * Builds one MCP server instance with every tool registered. Called once per
 * process in stdio mode and once per request by the stateless HTTP entry.
 */
export function buildProcoreMcpServer(): McpServer {
  const server = new McpServer({
    name: "procore",
    version: packageVersion(),
  });

  registerTools(server);

  let autoCount = 0;
  if ((process.env.PROCORE_TOOL_MODE || "meta").toLowerCase() === "all") {
    autoCount = registerAutoTools(server);
    console.error(`Auto-registered ${autoCount} endpoint tools`);
  }

  return server;
}
