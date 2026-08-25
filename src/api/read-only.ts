const READ_METHODS = new Set(["GET"]);
const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Read-only guard for the API client. Enabled by default so the server cannot
 * mutate Procore data unless an operator explicitly opts out with
 * PROCORE_READ_ONLY=false. Reads the environment on every call rather than at
 * import time so tests and long-lived processes can toggle it.
 */
export function isReadOnlyMode(): boolean {
  const raw = process.env.PROCORE_READ_ONLY;
  if (raw === undefined || raw.trim() === "") return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method.trim().toUpperCase());
}

export function readOnlyRejectionMessage(method: string): string {
  return (
    `Rejected: ${method.toUpperCase()} is not permitted. Procore writes are guarded on ` +
    "this server for now because they cannot be easily undone, so only GET requests are served."
  );
}

/** Throws before any auth or network work when the method violates read-only mode. */
export function assertMethodAllowed(method: string): void {
  if (!isReadOnlyMode() || isReadMethod(method)) return;
  throw new Error(readOnlyRejectionMessage(method));
}
