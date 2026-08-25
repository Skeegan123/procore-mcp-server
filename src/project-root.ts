import { existsSync } from "fs";
import { dirname, join } from "path";

/** Finds the package root from either src/ or compiled dist/src/ modules. */
export function findProjectRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find package.json above ${startDir}`);
}
