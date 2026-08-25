import { getRequestUserKey } from "../auth/request-context.js";

const RUNTIME_ID_KEYS = new Set(["company_id", "project_id"]);
const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;

export type RuntimeConfig = Record<string, string | number>;

/**
 * Procore company/project identifiers are positive integer IDs. Do not use
 * parseInt here: it accepts prefixes (for example, "12x" becomes 12), which
 * could silently send a request to a different company or project.
 */
export function parsePositiveSafeInteger(
  value: string | number,
  key: string
): number {
  const valid =
    typeof value === "number"
      ? Number.isSafeInteger(value) && value > 0
      : POSITIVE_INTEGER_STRING.test(value) &&
        Number.isSafeInteger(Number(value));

  if (!valid) {
    throw new Error(
      `"${key}" must be a positive safe integer. Got: "${String(value)}"`
    );
  }

  return typeof value === "number" ? value : Number(value);
}

export function isRuntimeIdKey(key: string): boolean {
  return RUNTIME_ID_KEYS.has(key);
}

export function getDefaultCompanyId(): number | null {
  const id = process.env.PROCORE_COMPANY_ID;
  return id ? parsePositiveSafeInteger(id, "PROCORE_COMPANY_ID") : null;
}

// In-memory runtime config stores (set via the procore_set_config tool).
// Stdio has no request user and keeps the original process-local behavior.
// Hosted requests are keyed by the authenticated user so one user's defaults
// can never be observed or used by another user's request.
let localRuntimeConfig: RuntimeConfig = {};
const userRuntimeConfigs = new Map<string, RuntimeConfig>();

function currentRuntimeConfig(): RuntimeConfig {
  const userKey = getRequestUserKey();
  if (userKey === undefined) return localRuntimeConfig;

  let config = userRuntimeConfigs.get(userKey);
  if (!config) {
    config = {};
    userRuntimeConfigs.set(userKey, config);
  }
  return config;
}

export function getRuntimeConfig(): RuntimeConfig {
  const userKey = getRequestUserKey();
  const config =
    userKey === undefined
      ? localRuntimeConfig
      : userRuntimeConfigs.get(userKey);
  return { ...(config || {}) };
}

export function setRuntimeConfig(key: string, value: string | number): void {
  const config = currentRuntimeConfig();
  if (isRuntimeIdKey(key)) {
    config[key] = parsePositiveSafeInteger(value, key);
    return;
  }

  config[key] = value;
}

/**
 * Clears defaults for the current request user. In stdio mode, where there is
 * no request user, this clears the legacy process-local defaults.
 */
export function clearRuntimeConfig(): void {
  const userKey = getRequestUserKey();
  if (userKey === undefined) {
    localRuntimeConfig = {};
    return;
  }
  userRuntimeConfigs.delete(userKey);
}
