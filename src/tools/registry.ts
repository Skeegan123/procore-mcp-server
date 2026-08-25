import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { handleDiscoverCategories } from "./handlers/discover-categories.js";
import { handleDiscoverEndpoints } from "./handlers/discover-endpoints.js";
import { handleGetEndpointDetails } from "./handlers/get-endpoint-details.js";
import { handleApiCall } from "./handlers/api-call.js";
import { handleSearchEndpoints } from "./handlers/search-endpoints.js";
import { handleGetConfig } from "./handlers/get-config.js";
import { handleSetConfig } from "./handlers/set-config.js";
import { isReadOnlyMode } from "../api/read-only.js";

/** The four discovery tools and get_config read only the catalog bundled with
 *  this server — no Procore request, no credentials, nothing observable
 *  outside this process, hence openWorldHint: false. */
const LOCAL_READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer): void {
  const readOnly = isReadOnlyMode();
  const readOnlyNote = readOnly
    ? "Procore writes are guarded on this server for now because they cannot be easily undone, so only GET endpoints are listed."
    : "";
  // 1. Discover Categories
  server.registerTool(
    "procore_discover_categories",
    {
      title: "Discover Procore API Categories",
      description:
        "Lists Procore's API surface as a Category > Module tree with an endpoint count for each. " +
        "Start here when you do not yet know which part of Procore holds the data you need; if you " +
        "already know the resource by name ('RFI', 'budget'), procore_search_endpoints gets you there " +
        "in one step instead of three. The category and module names returned are the exact values " +
        "procore_discover_endpoints expects. Takes no arguments and returns a JSON object. " +
        "Reads the catalog bundled with this server, so it makes no Procore request and needs no " +
        "authentication — it cannot fail with 401/403 and costs no rate limit. " +
        "Step 1 of the discover -> detail -> call workflow.",
      inputSchema: z.object({}),
      annotations: { title: "Discover API Categories", ...LOCAL_READ_ONLY },
    },
    async () => {
      const text = await handleDiscoverCategories();
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // 2. Discover Endpoints
  server.registerTool(
    "procore_discover_endpoints",
    {
      title: "Discover Endpoints in a Category",
      description:
        "Lists the Procore endpoints inside one category or module, optionally narrowed by a summary " +
        "substring or HTTP method. Use it after procore_discover_categories to enumerate a focused " +
        "area; prefer procore_search_endpoints when you have a keyword but no category. " +
        "Every argument is optional, but omitting all of them returns the entire ~3,100-endpoint " +
        "catalog, so pass at least a category or a search term. " +
        "Returns a JSON array of {operationId, summary, method, path}; feed an operationId to " +
        "procore_get_endpoint_details. Filters that match nothing return an empty array, not an error. " +
        "Reads the bundled catalog: no Procore request, no authentication, no rate-limit cost. " +
        (readOnly ? readOnlyNote + " " : "") +
        "Step 2 of the workflow.",
      inputSchema: z.object({
              category: z
                .string()
                .optional()
                .describe(
                  "Top-level category, exactly as returned by procore_discover_categories, e.g. 'Project Management', 'Core', 'Construction Financials'"
                ),
              module: z
                .string()
                .optional()
                .describe(
                  "Module within the category, e.g. 'RFI', 'Submittals', 'Punch List'. Ignored unless category is also given."
                ),
              search: z
                .string()
                .optional()
                .describe(
                  "Case-insensitive substring matched against endpoint summary text; combine with category to narrow a large module"
                ),
              method_filter: z
                .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
                .optional()
                .describe(
                  "Restrict results to a single HTTP method — useful to list only the reads (GET) in a module"
                ),
            }),
      annotations: { title: "Discover Endpoints", ...LOCAL_READ_ONLY },
    },
    async (args) => {
      const text = await handleDiscoverEndpoints(args);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // 3. Get Endpoint Details
  server.registerTool(
    "procore_get_endpoint_details",
    {
      title: "Get Full Endpoint Details",
      description:
        "Returns the complete parameter schema for one Procore endpoint: every path, query, and body " +
        "field with its type and required flag, plus the response shape. " +
        "Call this after discovery and before procore_api_call — api_call needs exact parameter names, " +
        "and guessing them is the most common cause of a rejected request. " +
        "Takes the operationId string that procore_discover_endpoints and procore_search_endpoints " +
        "return; an unrecognized operation_id comes back as a not-found message rather than an error. " +
        "Reads the bundled catalog: no Procore request, no authentication, no rate-limit cost. " +
        "Step 3 of the workflow.",
      inputSchema: z.object({
              operation_id: z
                .string()
                .describe(
                  "The exact operationId from procore_discover_endpoints or procore_search_endpoints, e.g. 'RestV10ProjectsProjectIdRfisGet'. Case-sensitive; not a URL path."
                ),
            }),
      annotations: { title: "Get Endpoint Details", ...LOCAL_READ_ONLY },
    },
    async (args) => {
      const text = await handleGetEndpointDetails(args);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // 4. API Call (the core tool)
  // In read-only mode the schema itself only accepts GET, so a non-GET call is
  // rejected by input validation before it ever reaches the client — and the
  // client enforces the same policy again as a second layer.
  server.registerTool(
    "procore_api_call",
    {
      title: readOnly
        ? "Execute Procore API Read (GET)"
        : "Execute Any Procore API Call",
      description: readOnly
        ? "Executes a read-only GET request against the Procore REST API. Procore writes are " +
          "guarded on this server for now because they cannot be easily undone, so only GET " +
          "requests are served and no other method is accepted. " +
          "Resolve the exact path and parameters with procore_get_endpoint_details first. " +
          "Handles OAuth from the saved tokens, substitutes {placeholders} from path_params, and rewrites " +
          "double underscores in query keys into brackets (filters__status becomes filters[status]). " +
          "company_id and project_id fall back to whatever procore_set_config holds when the path needs " +
          "them and you omit them. " +
          "Returns the parsed JSON response together with pagination and rate-limit metadata. Failures " +
          "come back as an error payload carrying the HTTP status — commonly 401 when the token has " +
          "expired, 403 without tool permission, 404 when an id does not resolve, and 429 when the rate " +
          "limit is exhausted. " +
          "Step 4 of the workflow; this reaches every read endpoint, including any not exposed as a " +
          "dedicated tool. If a write seems necessary, stop and tell the user this server is read-only."
        : "Executes any Procore REST API call. This is the only tool here that reaches Procore and the " +
          "only one that can change data — resolve the exact method, path, and parameters with " +
          "procore_get_endpoint_details first. " +
          "WRITES ARE REAL: DELETE permanently removes the record, POST creates one, and PATCH/PUT " +
          "overwrite fields, so confirm the target id before calling and prefer a GET to verify it exists. " +
          "Handles OAuth from the saved tokens, substitutes {placeholders} from path_params, and rewrites " +
          "double underscores in query keys into brackets (filters__status becomes filters[status]). " +
          "company_id and project_id fall back to whatever procore_set_config holds when the path needs " +
          "them and you omit them. " +
          "Returns the parsed JSON response together with pagination and rate-limit metadata. Failures " +
          "come back as an error payload carrying the HTTP status — commonly 401 when the token has " +
          "expired, 403 without tool permission, 404 when an id does not resolve, 422 when the body fails " +
          "validation, and 429 when the rate limit is exhausted. " +
          "Step 4 of the workflow; this reaches every Procore endpoint, including any not exposed as a " +
          "dedicated tool.",
      inputSchema: z.object({
              method: (readOnly
                ? z.enum(["GET"])
                : z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
              ).describe(
                readOnly
                  ? "HTTP method for the endpoint. Only GET is available on this server."
                  : "HTTP method for the endpoint, exactly as reported by the discovery tools"
              ),
              path: z
                .string()
                .describe(
                  "API path with placeholders left intact, e.g. '/rest/v1.0/projects/{project_id}/rfis'. Supply the values via path_params rather than interpolating them here."
                ),
              path_params: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                  "Values substituted into the path's {placeholders}, e.g. { project_id: '12345' }. Required whenever the path contains a placeholder that procore_set_config does not already supply."
                ),
              query_params: z
                .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                .optional()
                .describe(
                  "Query-string parameters. Use double underscores for Procore's bracket syntax: filters__status becomes filters[status]."
                ),
              body: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                  "Request body for POST/PUT/PATCH. For multipart file fields, pass {base64, filename?, contentType?}; use the exact nesting from procore_get_endpoint_details. Ignored on GET and DELETE."
                ),
              content_type: z
                .enum([
                  "application/json",
                  "application/merge-patch+json",
                  "multipart/form-data",
                ])
                .optional()
                .describe(
                  "Request media type reported by procore_get_endpoint_details. Defaults to application/json when a body is present."
                ),
              company_id: z
                .number()
                .optional()
                .describe(
                  "Overrides the Procore-Company-Id header for this call only; defaults to the configured company"
                ),
              page: z
                .number()
                .optional()
                .describe("1-indexed page number for paginated endpoints (default 1)"),
              per_page: z
                .number()
                .optional()
                .describe("Items per page, 1-100 (default 100)"),
            }),
      annotations: {
        title: readOnly ? "Procore API Read" : "Procore API Call",
        // In read-only mode every reachable call is a GET, so the tool is
        // genuinely read-only and the hints say so.
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    },
    async (args) => {
      const result = await handleApiCall(args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: result.isError,
      };
    }
  );

  // 5. Search Endpoints
  server.registerTool(
    "procore_search_endpoints",
    {
      title: "Full-Text Search Across Endpoints",
      description:
        "Searches every Procore endpoint's summary, tag, and path for a term and returns the matches " +
        "ranked by relevance. This is the fastest way in when you already know roughly what you want " +
        "('punch list', 'submittal', 'budget line item'); reach for procore_discover_categories instead " +
        "when you want to browse the API surface rather than search it. " +
        "Returns a JSON array of {operationId, summary, method, path}; feed an operationId to " +
        "procore_get_endpoint_details to get its parameters. A term with no matches returns an empty " +
        "array, so retry with a broader or singular form before concluding the endpoint does not exist. " +
        "Reads the bundled catalog: no Procore request, no authentication, no rate-limit cost." +
        (readOnly ? " " + readOnlyNote : ""),
      inputSchema: z.object({
              query: z
                .string()
                .describe(
                  "Search term matched against endpoint summaries, tags, and paths, e.g. 'RFI', 'budget', 'punch list'. Single keywords match more broadly than phrases."
                ),
            }),
      annotations: { title: "Search Endpoints", ...LOCAL_READ_ONLY },
    },
    async (args) => {
      const text = await handleSearchEndpoints(args);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // 6. Get Config
  server.registerTool(
    "procore_get_config",
    {
      title: "Show Server Configuration",
      description:
        "Reports this server's current state: whether Procore OAuth tokens are present and still valid, " +
        "the default company_id, and the active project_id that procore_api_call substitutes when you " +
        "omit those parameters. " +
        "Check this first when a call fails with 401 or 403, or to confirm which project subsequent " +
        "calls will target before running a write. " +
        "Never returns token values or the client secret — only whether credentials are present. " +
        "Takes no arguments and returns a JSON object. Reads local process state, so it makes no " +
        "Procore request. Pair with procore_set_config to change any of it.",
      inputSchema: z.object({}),
      annotations: { title: "Show Config", ...LOCAL_READ_ONLY },
    },
    async () => {
      const text = await handleGetConfig();
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // 7. Set Config
  server.registerTool(
    "procore_set_config",
    {
      title: "Set Runtime Configuration Value",
      description:
        "Sets the default company_id or project_id that later procore_api_call requests use when the " +
        "path needs one and you omit it. A value in path_params wins for that URL placeholder, and a " +
        "per-call company_id wins for that call's header and company placeholder. The runtime company " +
        "value also overrides PROCORE_COMPANY_ID for the Procore-Company-Id header. Use this to switch " +
        "project context mid-session instead of restarting the server, then call procore_get_config to " +
        "confirm what took effect. Only 'company_id' and 'project_id' are accepted; each must be a " +
        "positive safe integer represented by complete decimal digits. Partial strings such as '12x', " +
        "zero, negatives, decimals, and values above 9007199254740991 are reported back as a message " +
        "rather than stored. " +
        "The change lives in memory for this server process only — it is never written to disk and is " +
        "lost on restart. Setting the same value twice is a no-op, and nothing in Procore is modified: " +
        "this only changes which ids this server fills in for you. " +
        "Returns a confirmation plus the full updated configuration.",
      inputSchema: z.object({
              key: z
                .enum(["company_id", "project_id"])
                .describe(
                  "Which default to set. These are the only accepted keys; any other value is rejected."
                ),
              value: z
                .string()
                .describe(
                  "The ID to store as complete decimal digits (e.g. '12345'). It must be a positive safe integer; partial strings such as '12x', zero, negatives, decimals, and values above 9007199254740991 are rejected."
                ),
            }),
      annotations: {
        title: "Set Config",
        readOnlyHint: false,
        // Changes only this process's in-memory defaults; nothing in Procore.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const text = await handleSetConfig(args);
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
