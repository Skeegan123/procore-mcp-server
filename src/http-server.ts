import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  buildProcoreMcpServer,
  ensureCatalogLoaded,
  loadEnvFile,
  logStartupContext,
} from "./server-builder.js";
import { runAsUser } from "./auth/request-context.js";
import {
  buildOAuthAuthorizationUrl,
} from "./auth/oauth-state.js";
import { getAuthBaseUrl, exchangeCodeForTokens } from "./auth/oauth.js";
import { isReadOnlyMode } from "./api/read-only.js";
import {
  createGrant,
  createPendingAuthorization,
  consumeGrant,
  deletePendingAuthorization,
  getPendingAuthorization,
  issueAccessToken,
  verifyAccessToken,
} from "./auth/hosted-auth.js";

/**
 * Hosted entry point: a stateless Streamable HTTP MCP server plus the OAuth
 * endpoints that let each user sign in to Procore as themselves.
 *
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /oauth/authorize   -> redirects to Procore's login
 *   GET  /oauth/callback    -> Procore returns here; grants are minted
 *   POST /oauth/token       -> authorization code + PKCE -> access token
 *   ANY  /mcp               -> the MCP endpoint (Bearer token required)
 *   GET  /healthz           -> liveness probe
 */

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 10_000;

class RequestBodyError extends Error {
  constructor(
    readonly statusCode: 408 | 413,
    readonly errorCode: "request_timeout" | "payload_too_large",
    message: string
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

function positiveEnvInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function maxBodyBytes(): number {
  return positiveEnvInteger("PROCORE_MCP_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);
}

function bodyReadTimeoutMs(): number {
  return positiveEnvInteger("PROCORE_MCP_BODY_TIMEOUT_MS", DEFAULT_BODY_READ_TIMEOUT_MS);
}

function baseUrl(): string {
  const raw = process.env.PROCORE_MCP_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
  return raw.replace(/\/+$/, "");
}

function redirectUris(): string[] | null {
  // Explicit allowlist wins. With PROCORE_ALLOW_ANY_REDIRECT=true any https
  // redirect URI is accepted (development only). Otherwise hosted OAuth is
  // disabled and /oauth/authorize explains what to configure.
  const list = (process.env.PROCORE_OAUTH_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  if ((process.env.PROCORE_ALLOW_ANY_REDIRECT || "").toLowerCase() === "true") {
    return null; // caller checks scheme itself
  }
  return [];
}

function isRedirectUriAllowed(uri: string): boolean {
  const allowed = redirectUris();
  if (allowed === null) return uri.startsWith("https://");
  return allowed.includes(uri);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, url: string): void {
  res.writeHead(302, { Location: url });
  res.end();
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const limit = maxBodyBytes();
  const declaredLength = req.headers["content-length"];
  const declaredBytes = typeof declaredLength === "string" ? Number(declaredLength) : null;
  if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > limit) {
    // Keep the connection usable when the client declared an oversized body.
    // The top-level handler closes it after sending the 413 if it is still
    // incomplete; resume() prevents unread bytes from blocking the parser.
    req.resume();
    throw new RequestBodyError(
      413,
      "payload_too_large",
      `Request body exceeds the ${limit}-byte limit.`
    );
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const rejectWith = (error: Error) => {
      finish(() => reject(error));
      // Once the body is known to be unusable, discard it without retaining
      // data. The server callback will close an incomplete request after the
      // error response has flushed.
      req.resume();
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > limit) {
        rejectWith(
          new RequestBodyError(
            413,
            "payload_too_large",
            `Request body exceeds the ${limit}-byte limit.`
          )
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (error: Error) => finish(() => reject(error));
    const onAborted = () =>
      rejectWith(new RequestBodyError(408, "request_timeout", "The request body was aborted."));
    const onClose = () => {
      if (!req.complete) {
        rejectWith(new RequestBodyError(408, "request_timeout", "The request body was incomplete."));
      }
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
    timer = setTimeout(() => {
      rejectWith(
        new RequestBodyError(
          408,
          "request_timeout",
          `Request body was not received within ${bodyReadTimeoutMs()}ms.`
        )
      );
    }, bodyReadTimeoutMs());
    timer.unref();
  });
}

export function startHttpServer(): ReturnType<typeof createServer> {
  loadEnvFile();
  logStartupContext();
  ensureCatalogLoaded();

  // One factory backs every request; each gets a fresh server instance with
  // no shared state, so plain round-robin scaling works.
  const handler = createMcpHandler(() => buildProcoreMcpServer(), {
    onerror: (err) => console.error("MCP handler error:", err.message),
  });

  // Auth + user identity wrap the fetch face; AsyncLocalStorage carries the
  // user id into every tool handler so Procore calls use that user's tokens.
  const mcpNodeHandler = toNodeHandler({
    fetch: async (request) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
      const userId = verifyAccessToken(token);
      if (!userId) {
        return new Response(
          JSON.stringify({
            error: "unauthorized",
            error_description: "Sign in via the OAuth authorization flow to use this server.",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate":
                `Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource"`,
            },
          }
        );
      }
      return runAsUser(userId, () => handler.fetch(request));
    },
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await route(req, res, mcpNodeHandler);
    } catch (err) {
      if (err instanceof RequestBodyError) {
        const closeAfterResponse = !req.complete;
        if (!res.headersSent) {
          res.writeHead(err.statusCode, {
            "Content-Type": "application/json",
            ...(closeAfterResponse ? { Connection: "close" } : {}),
          });
          res.end(
            JSON.stringify({ error: err.errorCode, error_description: err.message }),
            () => {
              if (closeAfterResponse && !req.destroyed) req.destroy();
            }
          );
        } else {
          res.end();
        }
        return;
      }
      console.error("HTTP error:", (err as Error).message);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
      else res.end();
    }
  });

  const port = Number.parseInt(process.env.PORT || "", 10) || DEFAULT_PORT;
  server.listen(port, () => {
    console.error(`Procore MCP HTTP server listening on port ${port}`);
    console.error(`MCP endpoint: ${baseUrl()}/mcp`);
    console.error(
      isReadOnlyMode()
        ? "Read-only mode is ON — every served tool call is a GET."
        : "WARNING: read-only mode is OFF; users can write to Procore."
    );
  });
  return server;
}

// Only auto-start when run as the entry module (not under test import).
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  startHttpServer();
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  mcpNodeHandler: ReturnType<typeof toNodeHandler>
): Promise<void> {
  const url = new URL(req.url || "/", baseUrl());
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();

  switch (path) {
    case "/healthz":
      json(res, 200, { ok: true, read_only: isReadOnlyMode() });
      return;

    case "/.well-known/oauth-protected-resource":
      json(res, 200, {
        resource: `${baseUrl()}/mcp`,
        authorization_servers: [baseUrl()],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
        resource_documentation: `${baseUrl()}/`,
      });
      return;

    case "/.well-known/oauth-authorization-server":
      json(res, 200, {
        issuer: baseUrl(),
        authorization_endpoint: `${baseUrl()}/oauth/authorize`,
        token_endpoint: `${baseUrl()}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        service_documentation:
          "Sign-in proxies to Procore: users authenticate with their own Procore account.",
      });
      return;

    case "/oauth/authorize": {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const responseType = url.searchParams.get("response_type");
      const clientState = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const challengeMethod = url.searchParams.get("code_challenge_method");

      const fail = (error: string, description: string) =>
        json(res, 400, { error, error_description: description });

      if (!clientId) return fail("invalid_request", "client_id is required");
      if (!redirectUri) return fail("invalid_request", "redirect_uri is required");
      if (!isRedirectUriAllowed(redirectUri)) {
        return fail("invalid_request", "redirect_uri is not on this server's allowlist");
      }
      if (responseType !== "code") {
        return fail("unsupported_response_type", "only response_type=code is supported");
      }
      if (!codeChallenge || challengeMethod !== "S256") {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
      }

      // The browser now signs in at Procore as themselves. Our callback comes
      // back with the user's own tokens, bound to this pending request.
      const ourState = createPendingAuthorization({
        clientId,
        redirectUri,
        clientState,
        codeChallenge,
      });
      redirect(
        res,
        buildOAuthAuthorizationUrl(getAuthBaseUrl(), process.env.PROCORE_CLIENT_ID || "", `${baseUrl()}/oauth/callback`, ourState)
      );
      return;
    }

    case "/oauth/callback": {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const ourState = url.searchParams.get("state");

      const pending = ourState ? getPendingAuthorization(ourState) : null;
      if (!pending) {
        json(res, 400, {
          error: "invalid_state",
          error_description: "Unknown or expired sign-in attempt. Start again.",
        });
        return;
      }

      const back = (params: Record<string, string>) => {
        deletePendingAuthorization(ourState!);
        const target = new URL(pending.redirectUri);
        for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
        if (pending.clientState) target.searchParams.set("state", pending.clientState);
        redirect(res, target.toString());
      };

      if (error || !code) {
        back({ error: "access_denied", error_description: error || "Procore sign-in did not complete." });
        return;
      }

      const userId = randomBytes(16).toString("hex");
      try {
        await exchangeCodeForTokens(code, `${baseUrl()}/oauth/callback`, userId);
      } catch (err) {
        console.error("Procore token exchange failed:", (err as Error).message);
        back({ error: "server_error", error_description: "Exchanging the Procore authorization code failed." });
        return;
      }

      const grant = createGrant({
        userId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
      });
      back({ code: grant });
      return;
    }

    case "/oauth/token": {
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get("grant_type");
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");

      if (
        grantType !== "authorization_code" ||
        !code ||
        !verifier ||
        !redirectUri
      ) {
        json(res, 400, { error: "invalid_request" });
        return;
      }

      const grant = consumeGrant(code, verifier, redirectUri);
      if (!grant) {
        json(res, 400, { error: "invalid_grant", error_description: "The code is invalid, expired, or already used." });
        return;
      }

      const { token, expiresIn } = issueAccessToken(grant.userId);
      json(res, 200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
      });
      return;
    }

    default:
      if (path === "/mcp" || path.startsWith("/mcp/")) {
        mcpNodeHandler(req, res);
        return;
      }
      json(res, 404, { error: "not_found" });
  }
}
