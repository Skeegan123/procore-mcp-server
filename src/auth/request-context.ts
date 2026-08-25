import { AsyncLocalStorage } from "async_hooks";

const storage = new AsyncLocalStorage<string>();

/**
 * Identifies whose Procore tokens serve the current call. Undefined in local
 * stdio mode, which keeps using the single legacy token file.
 */
export function runAsUser<T>(userKey: string, fn: () => T): T {
  return storage.run(userKey, fn);
}

export function getRequestUserKey(): string | undefined {
  return storage.getStore();
}
