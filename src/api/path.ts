import {
  isRuntimeIdKey,
  parsePositiveSafeInteger,
  type RuntimeConfig,
} from "./runtime-config.js";

export function substitutePath(
  path: string,
  params: Record<string, string> | undefined,
  runtimeConfig: RuntimeConfig,
  perCallCompanyId: number | undefined,
  defaultCompanyId: number | null
): string {
  const unresolved = new Set<string>();
  const result = path.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
    let value: string | number | undefined;

    // Explicit path parameters always win. An empty string is still treated
    // as explicit so that the unresolved-placeholder check remains honest;
    // Procore's ID placeholders are validated below.
    if (params?.[key] !== undefined) {
      value = params[key];
    } else if (key === "company_id" && perCallCompanyId !== undefined) {
      // companyId is a per-call override for both the header and a matching
      // company_id path placeholder.
      value = perCallCompanyId;
    } else if (key === "company_id") {
      // The environment default is the final company fallback. Runtime
      // config takes precedence because it appears before this fallback.
      value = runtimeConfig.company_id ?? defaultCompanyId ?? undefined;
    } else if (key === "project_id") {
      value = runtimeConfig.project_id;
    }

    if (value === undefined) {
      unresolved.add(key);
      return placeholder;
    }

    if (isRuntimeIdKey(key)) {
      // Validate explicit path values as well as values from runtime config.
      // Keep the caller's spelling for non-configured path values, but only
      // after proving that it is a complete safe integer.
      parsePositiveSafeInteger(value, key);
    }

    return encodeURIComponent(String(value));
  });

  if (unresolved.size > 0) {
    const names = [...unresolved].map((name) => `{${name}}`).join(", ");
    throw new Error(
      `Unresolved path parameter${unresolved.size === 1 ? "" : "s"}: ${names}. ` +
        "Supply the value in pathParams or set the matching runtime config."
    );
  }

  return result;
}

export function buildQueryString(
  params?: Record<string, string | number | boolean>,
  page?: number,
  perPage?: number
): string {
  const qs = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (key.includes("__")) {
        // Convert filters__field back to filters[field]
        const parts = key.split("__");
        const converted = parts[0] + "[" + parts.slice(1).join("][") + "]";
        qs.set(converted, String(value));
      } else {
        qs.set(key, String(value));
      }
    }
  }
  if (page !== undefined) qs.set("page", String(page));
  if (perPage !== undefined) qs.set("per_page", String(perPage));
  const str = qs.toString();
  return str ? `?${str}` : "";
}
