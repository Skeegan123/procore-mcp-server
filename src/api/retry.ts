const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 5 * 60_000;

export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 1000;

interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: number;
}

let rateLimitState: RateLimitState = {
  remaining: Infinity,
  limit: 0,
  resetAt: 0,
};

export function getRateLimitState(): RateLimitState {
  return { ...rateLimitState };
}

export function updateRateLimitState(headers: Headers): void {
  const rlRemaining = headers.get("X-Rate-Limit-Remaining");
  const rlLimit = headers.get("X-Rate-Limit-Limit");
  const rlReset = headers.get("X-Rate-Limit-Reset");
  const parsedRemaining =
    rlRemaining === null ? NaN : Number.parseInt(rlRemaining, 10);
  const parsedLimit = rlLimit === null ? NaN : Number.parseInt(rlLimit, 10);
  const parsedReset = rlReset === null ? NaN : Number.parseInt(rlReset, 10);
  const resetAt = parsedReset * 1000;
  if (Number.isFinite(parsedRemaining)) {
    rateLimitState = {
      remaining: parsedRemaining,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : rateLimitState.limit,
      resetAt: Number.isFinite(resetAt)
        ? Math.min(resetAt, Date.now() + MAX_RATE_LIMIT_DELAY_MS)
        : rateLimitState.resetAt,
    };
  }
}

export function markRateLimited(waitMs: number): void {
  rateLimitState.remaining = 0;
  rateLimitState.resetAt = Date.now() + waitMs;
}

export function getTimeoutMs(option?: number): number {
  const configured =
    option ?? Number.parseInt(process.env.PROCORE_REQUEST_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(configured), MAX_TIMEOUT_MS);
}

export function remainingBeforeDeadline(deadline: number, timeoutMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`Procore API request timed out after ${timeoutMs}ms`);
  }
  return remaining;
}

export async function waitBeforeDeadline(
  waitMs: number,
  deadline: number,
  timeoutMs: number
): Promise<void> {
  const remaining = remainingBeforeDeadline(deadline, timeoutMs);
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs >= remaining) {
    throw new Error(
      `Procore rate-limit delay exceeds the ${timeoutMs}ms request timeout`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export async function waitForRateLimit(
  deadline: number,
  timeoutMs: number
): Promise<void> {
  if (rateLimitState.remaining <= 0 && rateLimitState.resetAt > Date.now()) {
    const waitMs = rateLimitState.resetAt - Date.now() + 100;
    console.error(`Rate limited. Waiting ${(waitMs / 1000).toFixed(1)}s...`);
    await waitBeforeDeadline(waitMs, deadline, timeoutMs);
  }
}

export function retryAfterMs(value: string | null): number {
  if (!value) return 10_000;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), MAX_RATE_LIMIT_DELAY_MS);
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), MAX_RATE_LIMIT_DELAY_MS)
    : 10_000;
}
