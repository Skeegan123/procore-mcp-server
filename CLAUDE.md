# Procore MCP Server

> MCP server exposing the full Procore REST API for Claude Desktop and Claude Code. Single-user OAuth. TypeScript + @modelcontextprotocol/sdk.

## Quick Start

```bash
npm install
npm run build          # Generate catalog from OAS + compile TypeScript
npm run auth           # One-time: OAuth flow to get Procore tokens
npm start              # Start MCP server (stdio transport)
```

## Architecture

**7 MCP tools** provide full coverage of Procore API endpoints:

| Tool | Purpose |
|------|---------|
| `procore_discover_categories` | List API categories with endpoint counts |
| `procore_discover_endpoints` | List endpoints in a category/module |
| `procore_get_endpoint_details` | Get full parameter schema for an endpoint |
| `procore_api_call` | Execute any Procore API call |
| `procore_search_endpoints` | Full-text search across endpoints |
| `procore_get_config` | Show current config (company_id, auth status) |
| `procore_set_config` | Set runtime config (company_id, project_id) |

### Build Pipeline

`specs/combined_OAS.json` (~54MB) -> `scripts/generate-catalog.ts` -> `data/catalog.json` + `data/endpoint-details/` -> `scripts/generate-tools-manifest.ts` -> `data/tools-manifest.json`

Current spec (2026-08-04): 3,155 operations -> 2,929 generated tools + 7 meta tools.
The manifest drops older-version duplicates of the same path and the
non-callable `/oauth/*` endpoints; both stay reachable via `procore_api_call`.

### Tool Description Quality

Generated tool descriptions are assembled from one sentence per scoring
dimension, and no sentence may restate another:

| Module | Responsibility |
|--------|----------------|
| `src/tools/resource-label.ts` | Names the actual resource from the OAS summary (never the category) |
| `src/tools/purpose-builder.ts` | Verb-aware purpose synthesis (a reorder is never described as a create) |
| `src/tools/description-builder.ts` | Deprecation notice, usage guidance, prerequisites, assembly |
| `src/tools/behavior-builder.ts` | Return shape, side effects, failure modes |
| `src/tools/param-descriptions.ts` | Per-parameter prose and source hints |
| `src/tools/annotation-builder.ts` | Titles and MCP annotations |
| `src/tools/version-sibling-note.ts` | Names cross-version sibling tools in the description |

Pagination is advertised only when the endpoint genuinely returns a collection
(`returnsCollection`), in both the description and the input schema.
`schemaIsCollection` in `scripts/generate-catalog.ts` unwraps `{ data: [...] }`
envelopes (and any single-property object wrapping an array, whatever it's
named — Procore's v1.0 endpoints often envelope under the plural resource
name, e.g. `{ exchange_rates: [...] }`) and merges `allOf` branches into one
schema before judging it, rather than treating `allOf` like `oneOf` (an
optional array-typed field on one branch doesn't make the *merged* object a
list). When the schema itself asserts a single object, that verdict only
flips on strong corroboration: a non-`{id}` path trusts either declared
pagination or explicit list language in the summary/description; an
`{id}`-shaped path requires *both*, since Procore sometimes declares
`page`/`per_page` on a genuine show-by-id endpoint with no textual list
signal behind it. The envelope key is recorded as `collectionEnvelope` and
named in the behavior sentence.

Three rules keep the prose honest, all enforced by `npm test`
(`scripts/verify-manifest.ts`, which also runs in CI):

- **Never claim semantics the name does not carry.** A POST named `reorder_*`
  is not a create, a DELETE named `recycle_*` is a soft delete, and a
  `bulk_*`/`sync_*` call is described in the plural.
- **Name the right record.** The id closing a path is the *target*, not a
  "parent record"; non-identifier path params (`{new_status}`) are neither.
- **Disambiguate cross-version siblings.** When Procore exposes the same
  operation at two API versions under different paths (dedup can't merge
  them — e.g. v1.1 moved weather logs under `daily_logs/`), each tool's
  description names its sibling(s) rather than reading identically. Grouping
  is by normalized summary text, guarded so a generic summary reused across
  unrelated resources ("Create Attachment" on witness statements, checklist
  lists, incidents, ...) doesn't get treated as one family, and so a
  `bulk_*`/`batch_*` endpoint never gets paired with the single-record
  version of the same summary.

Name collisions are broken with meaning-bearing suffixes (scope, version,
distinguishing path segment, HTTP method) before falling back to numbers.

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/auth/` | OAuth token exchange, refresh, storage |
| `src/api/` | HTTP client with auth, rate limits, retries |
| `src/catalog/` | Endpoint catalog loading, search, filtering |
| `src/tools/` | MCP tool handlers and registration |
| `scripts/` | Build-time catalog generation and validation |
| `data/` | Build output: catalog.json, endpoint details |
| `specs/` | Source OAS file (gitignored) |

### Auth Flow

1. Run `npm run auth` -> opens browser -> Procore OAuth -> tokens saved to `~/.procore-mcp/tokens.json`
2. MCP server reads tokens on startup, auto-refreshes when expired

### Environment Variables

```
PROCORE_CLIENT_ID     - OAuth client ID from Procore Developer Portal
PROCORE_CLIENT_SECRET - OAuth client secret
PROCORE_COMPANY_ID    - Default Procore company ID (integer)
PROCORE_TOOL_MODE     - "all" (default) or "meta" (serve only the 7 discovery
                        tools; endpoints stay reachable via procore_api_call)
```

## Releasing

Releases are cut by hand. **Bump `package.json` in the same PR as the release** —
it is not updated automatically, and silently drifted from the tags between
v1.0.0 and v1.2.0.

1. Merge the work to `main`.
2. Set `version` in `package.json` to the version being shipped.
3. Tag and publish:
   `gh release create vX.Y.Z --target main --title "..." --notes-file NOTES.md`

Notes: `--target` takes a branch name or a full commit SHA — an abbreviated SHA
is rejected. Write notes to a file rather than inlining them; long `--notes`
heredocs are easy to mangle.

## Coding Conventions

- TypeScript strict mode, ES2022 target, Node16 modules
- Node built-in fetch (no axios)
- File size limit: 300 lines per file
- All env vars validated at startup
