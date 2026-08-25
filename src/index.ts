import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  buildProcoreMcpServer,
  ensureCatalogLoaded,
  loadEnvFile,
  logStartupContext,
} from "./server-builder.js";

async function main(): Promise<void> {
  loadEnvFile();
  logStartupContext();
  ensureCatalogLoaded();

  const server = buildProcoreMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Procore MCP server running over stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
