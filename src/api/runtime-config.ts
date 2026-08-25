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

// In-memory runtime config store (set via the procore_set_config tool).
let runtimeConfig: RuntimeConfig = {};

export function getRuntimeConfig(): RuntimeConfig {
  return { ...runtimeConfig };
}

export function setRuntimeConfig(key: string, value: string | number): void {
  if (isRuntimeIdKey(key)) {
    runtimeConfig[key] = parsePositiveSafeInteger(value, key);
    return;
  }

  runtimeConfig[key] = value;
}

/** Clears process-local defaults. Intended for controlled resets and tests. */
export function clearRuntimeConfig(): void {
  runtimeConfig = {};
}
