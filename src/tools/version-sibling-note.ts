/**
 * Names sibling tools that carry out the same operation at a different
 * Procore API version. Two tools reading as identical prose except for a
 * version-number suffix left agents unable to tell them apart; this sentence
 * is the disambiguator. Split out of description-builder.ts to keep it under
 * the project's 300-line file limit.
 */
export interface VersionSiblingInput {
  versionSiblings?: Array<{ toolName: string; version: string }>;
}

export function buildVersionSiblingNote(entry: VersionSiblingInput): string {
  const siblings = entry.versionSiblings;
  if (!siblings || siblings.length === 0) return "";
  const others = siblings
    .map((s) => `${s.toolName} (${s.version})`)
    .join(", ");
  return `Procore also exposes this operation as ${others}; prefer the highest API version unless a caller specifically needs an older one's shape.`;
}
