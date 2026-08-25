import { getValidAccessToken, getApiBaseUrl } from "../auth/oauth.js";
import type { ApiCallOptions, ProcoreApiResponse } from "./types.js";
import {
  clearRuntimeConfig,
  getDefaultCompanyId,
  getRuntimeConfig,
  parsePositiveSafeInteger,
  setRuntimeConfig,
} from "./runtime-config.js";
import { buildQueryString, substitutePath } from "./path.js";
import { buildMultipartBody, isMultipartContentType } from "./multipart.js";
import {
  formatHttpErrorMessage,
  parseLinkHeader,
  ProcoreHttpError,
  readResponseBody,
} from "./response.js";
import {
  getRateLimitState,
  getTimeoutMs,
  markRateLimited,
  MAX_RETRIES,
  remainingBeforeDeadline,
  RETRY_BASE_MS,
  retryAfterMs,
  updateRateLimitState,
  waitBeforeDeadline,
  waitForRateLimit,
} from "./retry.js";

const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export { ProcoreHttpError };
export { clearRuntimeConfig, getRuntimeConfig, setRuntimeConfig };

export async function procoreApiCall(
  options: ApiCallOptions
): Promise<ProcoreApiResponse> {
  const { method, pathParams, queryParams, body, page, perPage } = options;
  let { path, companyId } = options;
  const timeoutMs = getTimeoutMs(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;

  // Resolve request context before auth. Apart from avoiding a needless token
  // refresh for malformed requests, this guarantees unresolved placeholders
  // fail before any network fetch can occur.
  const runtimeConfig = getRuntimeConfig();
  const perCallCompanyId =
    companyId === undefined
      ? undefined
      : parsePositiveSafeInteger(companyId, "company_id");
  const runtimeCompanyId =
    runtimeConfig.company_id === undefined
      ? undefined
      : parsePositiveSafeInteger(runtimeConfig.company_id, "company_id");
  const defaultCompanyId =
    perCallCompanyId ?? runtimeCompanyId ?? getDefaultCompanyId();

  // Substitute path parameters.
  path = substitutePath(
    path,
    pathParams,
    runtimeConfig,
    perCallCompanyId,
    defaultCompanyId
  );

  // Build full URL.
  const qs = buildQueryString(queryParams, page, perPage);
  const url = `${getApiBaseUrl()}${path}${qs}`;

  // Get auth token.
  const token = await getValidAccessToken(
    remainingBeforeDeadline(deadline, timeoutMs)
  );
  remainingBeforeDeadline(deadline, timeoutMs);

  const methodUpper = method.toUpperCase();
  const hasBody =
    BODY_METHODS.has(methodUpper) && body !== undefined && body !== null;
  const requestContentType = (
    options.contentType || (hasBody ? "application/json" : "")
  ).trim();
  const multipart = isMultipartContentType(requestContentType);

  // Do not send a JSON content type on bodyless requests, and never set a
  // multipart boundary ourselves. Fetch adds the boundary when it sees the
  // FormData body.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (hasBody && !multipart) {
    headers["Content-Type"] = requestContentType || "application/json";
  }

  if (defaultCompanyId !== null && defaultCompanyId !== undefined) {
    headers["Procore-Company-Id"] = String(defaultCompanyId);
  }

  const requestBody = hasBody
    ? multipart
      ? buildMultipartBody(body as Record<string, unknown>)
      : JSON.stringify(body)
    : undefined;
  const canRetry = RETRYABLE_METHODS.has(methodUpper);
  let retryCount = 0;
  let refreshAttempted = false;
  let retryDelayMs = 0;

  await waitForRateLimit(deadline, timeoutMs);

  while (true) {
    if (retryCount > 0) {
      const delay =
        retryDelayMs || RETRY_BASE_MS * Math.pow(2, retryCount - 1);
      retryDelayMs = 0;
      await waitBeforeDeadline(delay, deadline, timeoutMs);
    }

    const controller = new AbortController();
    let didTimeout = false;
    const attemptTimeoutMs = remainingBeforeDeadline(deadline, timeoutMs);
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, attemptTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: methodUpper,
        headers,
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const requestError = didTimeout
        ? new Error(`Procore API request timed out after ${timeoutMs}ms`)
        : (err as Error);
      if (canRetry && retryCount < MAX_RETRIES) {
        retryCount++;
        continue;
      }
      throw requestError;
    }

    updateRateLimitState(res.headers);

    // 429 is safe to repeat only for a read. A write that receives 429 is
    // surfaced immediately so this client never repeats a mutation.
    if (res.status === 429) {
      const waitMs = retryAfterMs(res.headers.get("Retry-After"));
      markRateLimited(waitMs);
      if (canRetry && retryCount < MAX_RETRIES) {
        await res.body?.cancel();
        clearTimeout(timeout);
        retryDelayMs = waitMs;
        retryCount++;
        continue;
      }
    }

    // Refresh and retry a read once after 401. Mutations surface the original
    // 401 because an intermediary could have processed a write before replying.
    if (res.status === 401 && !refreshAttempted && canRetry) {
      refreshAttempted = true;
      const { refreshAccessToken } = await import("../auth/oauth.js");
      try {
        await refreshAccessToken(remainingBeforeDeadline(deadline, timeoutMs));
        const newToken = await getValidAccessToken(
          remainingBeforeDeadline(deadline, timeoutMs)
        );
        await res.body?.cancel();
        clearTimeout(timeout);
        headers.Authorization = `Bearer ${newToken}`;
        continue;
      } catch {
        // Leave the original response body intact so the caller receives the
        // Procore 401 details instead of a body-cancelled stream error.
      }
    }

    // Only GET/HEAD requests may be retried after a server failure. The
    // response body is cancelled before moving on to avoid buffering it.
    if (
      res.status >= 500 &&
      res.status <= 599 &&
      canRetry &&
      retryCount < MAX_RETRIES
    ) {
      await res.body?.cancel();
      clearTimeout(timeout);
      retryCount++;
      continue;
    }

    let data: unknown;
    try {
      data = await readResponseBody(res);
    } catch (err) {
      if (didTimeout) {
        const timeoutError = new Error(
          `Procore API request timed out after ${timeoutMs}ms`
        );
        if (canRetry && retryCount < MAX_RETRIES) {
          retryCount++;
          continue;
        }
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new ProcoreHttpError(
        res.status,
        formatHttpErrorMessage(res.status, data),
        data
      );
    }

    const linkHeader = res.headers.get("Link");
    const totalHeader = res.headers.get("Total");
    const perPageHeader = res.headers.get("Per-Page");
    const links = parseLinkHeader(linkHeader);
    const pagination =
      linkHeader || totalHeader
        ? {
            current_page: page || 1,
            per_page: perPageHeader
              ? parseInt(perPageHeader, 10)
              : perPage || 20,
            has_next: !!links.next,
            total: totalHeader ? parseInt(totalHeader, 10) : undefined,
          }
        : undefined;

    return {
      status: res.status,
      data,
      pagination,
      rate_limit: (() => {
        const rateLimit = getRateLimitState();
        return {
          remaining: rateLimit.remaining,
          limit: rateLimit.limit,
          reset_at: rateLimit.resetAt,
        };
      })(),
    };
  }
}
