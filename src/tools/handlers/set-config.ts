import { setRuntimeConfig, getRuntimeConfig } from "../../api/client.js";

export async function handleSetConfig(args: {
  key: string;
  value: string;
}): Promise<string> {
  const allowedKeys = ["company_id", "project_id"];

  if (!allowedKeys.includes(args.key)) {
    return `Invalid config key: "${args.key}". Allowed keys: ${allowedKeys.join(", ")}`;
  }

  try {
    // setRuntimeConfig performs strict validation and canonicalizes IDs to a
    // number. In particular, it must not use parseInt, which would accept
    // partial values such as "12x".
    setRuntimeConfig(args.key, args.value);
  } catch (err) {
    return (err as Error).message;
  }

  const config = getRuntimeConfig();
  return `Config updated: ${args.key} = ${config[args.key]}\n\nCurrent config: ${JSON.stringify(config, null, 2)}`;
}
