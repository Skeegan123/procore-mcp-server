import type { ProcoreBinaryResponse } from "./types.js";

const MAX_BINARY_RESPONSE_BYTES = 32 * 1024;

/**
 * HTTP failures are thrown after the response body has been parsed. This lets
 * the dedicated tools mark them as MCP errors instead of presenting a 4xx or
 * 5xx response as if it were a successful API result.
 */
export class ProcoreHttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ProcoreHttpError";
    this.status = status;
    this.details = details;
  }
}

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("/json") || normalized.includes("+json");
}

function isBinaryContentType(
  contentType: string,
  contentDisposition: string | null
): boolean {
  const normalized = contentType.toLowerCase().split(";", 1)[0].trim();
  if (contentDisposition?.toLowerCase().includes("attachment")) return true;
  if (!normalized) return true;
  if (normalized.startsWith("text/")) return false;
  if (isJsonContentType(normalized)) return false;
  return ![
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-javascript",
    "application/graphql",
    "application/x-www-form-urlencoded",
  ].includes(normalized);
}

async function readBinaryResponse(
  response: Response,
  contentType: string
): Promise<ProcoreBinaryResponse> {
  const declaredLength = Number.parseInt(
    response.headers.get("content-length") || "",
    10
  );
  const totalBytes =
    Number.isFinite(declaredLength) && declaredLength >= 0
      ? declaredLength
      : undefined;
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let truncated = false;

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = MAX_BINARY_RESPONSE_BYTES - byteCount;
      if (remaining <= 0 || value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          byteCount += remaining;
        }
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      byteCount += value.byteLength;
      if (
        byteCount >= MAX_BINARY_RESPONSE_BYTES &&
        totalBytes !== undefined &&
        totalBytes > MAX_BINARY_RESPONSE_BYTES
      ) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    byteCount = Math.min(bytes.byteLength, MAX_BINARY_RESPONSE_BYTES);
    chunks.push(bytes.slice(0, byteCount));
    truncated = bytes.byteLength > byteCount;
  }

  const combined = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    kind: "binary",
    content_type: contentType || "application/octet-stream",
    encoding: "base64",
    data: Buffer.from(combined).toString("base64"),
    bytes: byteCount,
    total_bytes: totalBytes,
    truncated: truncated || (totalBytes !== undefined && totalBytes > byteCount),
  };
}

export async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const contentType = response.headers.get("content-type") || "";
  if (
    isBinaryContentType(
      contentType,
      response.headers.get("content-disposition")
    )
  ) {
    return readBinaryResponse(response, contentType);
  }

  const text = await response.text();
  if (!text) return null;
  if (isJsonContentType(contentType)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Keep malformed JSON visible to the caller instead of hiding the body.
    }
  }
  return text;
}

export function formatHttpErrorMessage(status: number, details: unknown): string {
  if (typeof details === "string" && details.trim()) {
    return `Procore API request failed with HTTP ${status}: ${details
      .trim()
      .slice(0, 2000)}`;
  }
  if (details && typeof details === "object" && "message" in details) {
    const message = (details as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return `Procore API request failed with HTTP ${status}: ${message.trim()}`;
    }
  }
  return `Procore API request failed with HTTP ${status}`;
}

export function parseLinkHeader(
  header: string | null
): { next?: string; total?: string } {
  if (!header) return {};
  const result: Record<string, string> = {};
  const parts = header.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="(\w+)"/);
    if (match) result[match[2]] = match[1];
  }
  return result;
}
