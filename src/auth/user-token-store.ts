import { createHash } from "crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { TokenData } from "./token-store.js";

/**
 * Per-user Procore token storage for hosted mode. Each authenticated user's
 * tokens live in their own file under PROCORE_USER_TOKEN_DIR so concurrent
 * sessions never overwrite each other and refresh-token rotation stays scoped
 * to one identity. The directory backend is intentionally isolated behind
 * these four functions so it can be swapped for S3/DynamoDB/etc without
 * touching callers.
 */

export function getUserTokenDir(): string {
  return process.env.PROCORE_USER_TOKEN_DIR || join(homedir(), ".procore-mcp", "users");
}

/** Hash the user key so untrusted ids can never traverse paths. */
function userFileName(userKey: string): string {
  const digest = createHash("sha256").update(userKey).digest("hex");
  return join(getUserTokenDir(), `${digest}.json`);
}

export function readUserTokens(userKey: string): TokenData | null {
  try {
    const raw = readFileSync(userFileName(userKey), "utf8");
    const data = JSON.parse(raw) as TokenData;
    if (!data.access_token || !data.refresh_token || !data.expires_at) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function writeUserTokens(userKey: string, tokens: TokenData): void {
  const target = userFileName(userKey);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmpPath = `${target}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmpPath, target);
}

export function deleteUserTokens(userKey: string): void {
  const target = userFileName(userKey);
  if (existsSync(target)) unlinkSync(target);
}
