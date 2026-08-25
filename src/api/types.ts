export interface ProcoreApiResponse {
  status: number;
  data: unknown;
  pagination?: {
    current_page: number;
    per_page: number;
    has_next: boolean;
    total?: number;
  };
  rate_limit?: {
    remaining: number;
    limit: number;
    reset_at: number;
  };
}

export interface ProcoreApiError {
  status: number;
  message: string;
  details?: unknown;
}

/**
 * A file sent through an MCP JSON argument. The bytes must be base64 encoded
 * because MCP tool arguments cannot carry a browser File or a Node Buffer.
 */
export interface ProcoreFileInput {
  base64: string;
  filename?: string;
  contentType?: string;
}

/** A bounded representation of a non-text HTTP response. */
export interface ProcoreBinaryResponse {
  kind: "binary";
  content_type: string;
  encoding: "base64";
  data: string;
  bytes: number;
  total_bytes?: number;
  truncated: boolean;
}

export interface ApiCallOptions {
  method: string;
  path: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  /** Request media type from the endpoint manifest, or an explicit override. */
  contentType?: string | null;
  companyId?: number;
  page?: number;
  perPage?: number;
  /** Internal/test override. Production calls use the finite server default. */
  timeoutMs?: number;
}
