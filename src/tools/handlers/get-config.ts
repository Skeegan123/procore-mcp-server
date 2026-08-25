import { getRuntimeConfig } from "../../api/client.js";
import { readTokens, isTokenExpired } from "../../auth/token-store.js";

export async function handleGetConfig(): Promise<string> {
  const runtimeConfig = getRuntimeConfig();
  const tokens = readTokens();

  const lines: string[] = ["## Procore MCP Server Configuration\n"];

  // Auth status
  if (tokens) {
    const expired = isTokenExpired(tokens);
    lines.push(
      `Auth: ${expired ? "Token expired (will auto-refresh on next call)" : "Authenticated"}`
    );
    const expiresAt = new Date(tokens.expires_at).toISOString();
    lines.push(`Token expires: ${expiresAt}`);
  } else {
    lines.push("Auth: Not authenticated. Run `npm run auth` to set up.");
  }

  // Company ID. Keep the source explicit: runtime values are process-local
  // overrides, while PROCORE_COMPANY_ID is only the environment fallback.
  const runtimeCompanyId = runtimeConfig.company_id;
  const environmentCompanyId = process.env.PROCORE_COMPANY_ID;
  const companyId = runtimeCompanyId ?? environmentCompanyId;
  lines.push(`\nDefault Company ID: ${companyId || "Not set"}`);
  if (runtimeCompanyId !== undefined) {
    lines.push("Company ID source: runtime override (process-local)");
  } else if (environmentCompanyId) {
    lines.push("Company ID source: PROCORE_COMPANY_ID environment variable");
  }

  // Runtime overrides
  if (runtimeConfig.project_id !== undefined) {
    lines.push(`Default Project ID: ${runtimeConfig.project_id}`);
    lines.push("Project ID source: runtime override (process-local)");
  }

  // Additional runtime config
  const otherKeys = Object.keys(runtimeConfig).filter(
    (k) => k !== "company_id" && k !== "project_id"
  );
  if (otherKeys.length > 0) {
    lines.push("\nRuntime config:");
    for (const key of otherKeys) {
      lines.push(`  ${key}: ${runtimeConfig[key]}`);
    }
  }

  lines.push(
    "\nUse procore_set_config to change runtime settings (company_id, project_id). " +
      "Runtime settings apply only to this server process and are lost on restart."
  );

  return lines.join("\n");
}
