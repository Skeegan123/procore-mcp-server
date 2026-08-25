# Procore MCP Server

[![procore-mcp-server MCP server](https://glama.ai/mcp/servers/TylerIlunga/procore-mcp-server/badges/card.svg)](https://glama.ai/mcp/servers/TylerIlunga/procore-mcp-server)

MCP server that exposes the full [Procore](https://www.procore.com/) REST API to AI assistants like Claude. Built with TypeScript and the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Works with **Claude Desktop**, **Claude Code**, and any MCP-compatible client.

This repository is a fork of [Tyler Ilunga's upstream project](https://github.com/TylerIlunga/procore-mcp-server). The original copyright and MIT license remain in force. Keep the notice in [LICENSE](LICENSE) when you redistribute this work.

## What it does

A build-time parser converts Procore's OpenAPI spec into a compact catalog, then auto-generates individual MCP tools for every API operation. At runtime, 7 meta-tools let the AI discover and call any Procore endpoint:

| Tool | Purpose |
|------|---------|
| `procore_discover_categories` | List API categories with endpoint counts |
| `procore_discover_endpoints` | List endpoints in a category |
| `procore_search_endpoints` | Full-text search across all endpoints |
| `procore_get_endpoint_details` | Get full parameter schema for an endpoint |
| `procore_api_call` | Execute any Procore API call |
| `procore_get_config` | Show current config and auth status |
| `procore_set_config` | Set runtime config (company_id, project_id) |

## Prerequisites

- Node.js 20+
- A [Procore Developer Portal](https://developers.procore.com/) account
- An OAuth app with **Authorization Code** grant type
- Set your redirect URI to `http://localhost`

## Setup

```bash
git clone https://github.com/TylerIlunga/procore-mcp-server.git
cd procore-mcp-server
npm ci
```

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

```env
PROCORE_CLIENT_ID=your_client_id
PROCORE_CLIENT_SECRET=your_client_secret
PROCORE_COMPANY_ID=your_company_id
PROCORE_ENV=production
PROCORE_TOOL_MODE=meta
PROCORE_READ_ONLY=true
```

`PROCORE_ENV` is `production` by default. Set it to `sandbox` only when your Procore app and account are configured for the sandbox. Keep production and sandbox tokens in separate files. Tokens are stored at `~/.procore-mcp/tokens.json` by default; set `PROCORE_TOKEN_PATH` to an absolute path when you need another location. The token file contains credentials and must stay private.

**Read-only mode** (`PROCORE_READ_ONLY`) is **on by default**. While enabled the
server serves GET requests only:

- `procore_api_call` accepts only `method: "GET"`; any other method is rejected
  before authentication or network activity, with a second enforcement layer in
  the API client itself.
- Discovery, search, and endpoint-detail tools list GET endpoints only, and
  `PROCORE_TOOL_MODE=all` registers dedicated tools for GET endpoints only.

Set `PROCORE_READ_ONLY=false` to restore full write access (POST/PUT/PATCH/DELETE).
Note this is a server-level guard for requests made through the MCP tools; it
cannot stop an agent that already has independent shell access from making its
own network calls, so keep the token file private regardless.

By default the server exposes the **7 compact meta tools**, including four read-only discovery tools and `procore_api_call`, and every Procore
endpoint is reached through `procore_api_call`. Registering a dedicated tool
per endpoint instead emits roughly 4.7 MB (~1.2M tokens) of tool definitions —
more than any current model's context window — so that surface is opt-in:

```env
PROCORE_TOOL_MODE=all
```

Coverage is identical in both modes; only the size of the advertised tool list
differs. If you switch to `all` and are migrating from before v2.0.0, see
`data/tool-renames.json` for the old -> new tool name map.

The generated catalog and endpoint details are committed, so a fresh clone does not need Procore's OpenAPI file. Validate the committed data and compile TypeScript with:

```bash
npm run build
```

Maintainers who have Procore's OpenAPI spec can refresh the generated data. Place the file at `specs/combined_OAS.json` (it is gitignored), then run:

```bash
npm run build:from-oas
```

The spec is not included in the repository because it is about 54 MB. Obtain it from [Procore's API documentation](https://developers.procore.com/). Review generated changes before committing them.

Authenticate with Procore (opens browser for OAuth):

```bash
npm run auth
```

Run authentication as your normal user. Do not use `sudo npm run auth`; it can create root-owned files and expose credentials to the wrong account. The flow saves tokens with restrictive file permissions.

Start the server:

```bash
npm start
```

## Claude Desktop configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "procore": {
      "command": "node",
      "args": ["/absolute/path/to/procore-mcp-server/dist/src/index.js"]
    }
  }
}
```

## Claude Code configuration

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "procore": {
      "command": "node",
      "args": ["/absolute/path/to/procore-mcp-server/dist/src/index.js"]
    }
  }
}
```

## Codex configuration

Codex stores local MCP servers in `~/.codex/config.toml`. The ChatGPT desktop app, Codex CLI, and the IDE extension share this configuration. See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) for client-specific options. After `npm run build`, add the following server entry. It keeps the compact `meta` tool surface and asks for approval before tools that are not read-only:

```toml
[mcp_servers.procore]
command = "node"
args = ["/absolute/path/to/procore-mcp-server/dist/src/index.js"]
cwd = "/absolute/path/to/procore-mcp-server"
enabled = true
required = false
startup_timeout_sec = 20
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
enabled_tools = [
  "procore_discover_categories",
  "procore_discover_endpoints",
  "procore_search_endpoints",
  "procore_get_endpoint_details",
  "procore_api_call",
  "procore_get_config",
  "procore_set_config",
]

[mcp_servers.procore.env]
PROCORE_TOOL_MODE = "meta"
```

Replace `/absolute/path/to/procore-mcp-server` with your clone's path. Keep client secrets and tokens in `.env` or another secret store, not in client configuration files. This server loads `.env` from the project directory. Restart Codex after saving the file and use `/mcp` to confirm that `procore` is connected. The `writes` approval mode is a default safety net. Review every `procore_api_call` that can change Procore data before approving it.

## Hosted mode (remote MCP, per-user sign-in)

> Full walkthrough — local testing steps, tunnel testing, container deployment, and
> the security model — lives in [`docs/hosted-deployment.md`](docs/hosted-deployment.md).

`npm run start:http` serves the same tools over stateless Streamable HTTP with a built-in OAuth layer so every user signs in to **their own** Procore account — no shared service account:

```
GET  /.well-known/oauth-protected-resource    MCP auth discovery
GET  /.well-known/oauth-authorization-server  OAuth metadata
GET  /oauth/authorize                         redirects to Procore login
GET  /oauth/callback                          Procore returns here
POST /oauth/token                             code + PKCE → access token
ANY  /mcp                                     MCP endpoint (Bearer token)
GET  /healthz                                 liveness probe
```

Each request carries its own bearer token and user identity, so there are no sessions: requests can land on any instance behind a plain load balancer or on serverless infrastructure.

Required environment (see `.env.example`):

- `PROCORE_MCP_BASE_URL` — public HTTPS URL of the deployment.
- `PROCORE_MCP_TOKEN_SECRET` — long random string used to sign access tokens.
- `PROCORE_OAUTH_REDIRECT_URIS` — allowlisted redirect URIs for MCP clients.
- Add `https://<your-host>/oauth/callback` as a redirect URI on your Procore app in the Developer Portal.

Per-user Procore tokens are stored as files under `PROCORE_USER_TOKEN_DIR` (default `~/.procore-mcp/users`). For multi-instance or serverless deployments where local disk is ephemeral, replace `src/auth/user-token-store.ts` with an S3/DynamoDB backend — callers only use its four functions.

To publish to ChatGPT Business/Enterprise web: admin enables developer mode under Workspace settings → Apps, creates a custom connector pointing at `https://<your-host>/mcp`, completes the OAuth sign-in as themselves, tests it, then publishes it workspace-wide.

Read-only mode applies to hosted mode too and stays on by default; keep it on unless you have reviewed what writes you want non-technical users triggering.

## Project structure

```
src/
  auth/       OAuth token exchange, refresh, storage (single-user + hosted per-user)
  api/        HTTP client with auth, rate limits, retries
  catalog/    Endpoint catalog loading, search, filtering
  tools/      MCP tool handlers and registration
scripts/
  generate-catalog.ts          Parse OAS into catalog
  generate-tools-manifest.ts   Generate per-endpoint MCP tools
  validate-catalog.ts          Validate catalog integrity
data/         Build output (committed): catalog.json, endpoint details, tools manifest
specs/        Source OAS file (gitignored — too large for the repo)
```

## How it works

1. **Build time**: `scripts/generate-catalog.ts` parses the ~54MB Procore OpenAPI spec (3,155 operations) and produces a compact `data/catalog.json` plus individual endpoint detail files in `data/endpoint-details/`. `scripts/generate-tools-manifest.ts` then generates a tools manifest with one named MCP tool per API operation — 2,929 in total, after collapsing older-version duplicates of the same path.

   Each generated tool carries a structured description covering what it acts on, when to reach for it, which parent ids to resolve first, what it returns, and how it fails. Endpoints Procore has deprecated are registered with their sunset date in the description and a `(Deprecated)` title. The interactive `/oauth/*` endpoints are not registered as tools — `npm run auth` owns that flow — but remain reachable through `procore_api_call`.

2. **Auth**: Run `npm run auth` once to complete the OAuth flow in your browser. Tokens are saved to `~/.procore-mcp/tokens.json` and auto-refresh when expired. `PROCORE_ENV=sandbox` uses the sandbox endpoints and should use a separate token path.

3. **Runtime**: The MCP server loads the catalog and registers the 7 compact meta tools (plus the full per-endpoint surface when `PROCORE_TOOL_MODE=all`). Four meta tools read only the local catalog; `procore_api_call` reaches Procore and may change data. The server injects auth headers, handles rate limits, and returns pagination metadata.

## Inspiration

Built to help my girlfriend, a construction engineer who uses Procore daily.

## License

MIT
