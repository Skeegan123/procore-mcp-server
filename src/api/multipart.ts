import type { ProcoreFileInput } from "./types.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_PARTS = 1_000;
const MAX_MULTIPART_DEPTH = 20;

export function isMultipartContentType(contentType: string): boolean {
  return (
    contentType.toLowerCase().split(";", 1)[0].trim() ===
    "multipart/form-data"
  );
}

function assertBase64(value: string): Uint8Array {
  const normalized = value
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const canonicalBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!canonicalBase64.test(normalized)) {
    throw new Error("File input must use canonical base64 with valid padding");
  }
  const estimatedBytes = Math.floor((normalized.length * 3) / 4);
  if (estimatedBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`File input exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`);
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File input exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`);
  }
  return new Uint8Array(bytes);
}

function isFileInput(value: unknown): value is ProcoreFileInput {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => ["base64", "filename", "contentType"].includes(key)) &&
    typeof (value as { base64?: unknown }).base64 === "string"
  );
}

interface MultipartBudget {
  bytes: number;
  parts: number;
}

function chargeMultipartBudget(budget: MultipartBudget, bytes: number): void {
  budget.parts++;
  budget.bytes += bytes;
  if (budget.parts > MAX_MULTIPART_PARTS) {
    throw new Error(
      `Multipart request exceeds the ${MAX_MULTIPART_PARTS} part limit`
    );
  }
  if (budget.bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Multipart request exceeds the ${MAX_UPLOAD_BYTES} byte limit`
    );
  }
}

function appendMultipartValue(
  form: FormData,
  key: string,
  value: unknown,
  budget: MultipartBudget,
  depth = 0
): void {
  if (value === undefined || value === null) return;
  if (depth > MAX_MULTIPART_DEPTH) {
    throw new Error(
      `Multipart value exceeds the ${MAX_MULTIPART_DEPTH} level nesting limit`
    );
  }

  if (isFileInput(value)) {
    const bytes = assertBase64(value.base64);
    chargeMultipartBudget(budget, bytes.byteLength);
    const contentType = value.contentType || "application/octet-stream";
    const blobBytes = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([blobBytes], { type: contentType });
    form.append(key, blob, value.filename || "upload.bin");
    return;
  }

  // This also supports direct callers that already have a Blob/File, while
  // MCP callers use ProcoreFileInput because Blob cannot cross JSON.
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    chargeMultipartBudget(budget, value.size);
    form.append(key, value, "upload.bin");
    return;
  }

  if (Array.isArray(value)) {
    const arrayKey = key.endsWith("[]") ? key : `${key}[]`;
    for (const item of value) {
      appendMultipartValue(form, arrayKey, item, budget, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      appendMultipartValue(
        form,
        `${key}[${nestedKey}]`,
        nestedValue,
        budget,
        depth + 1
      );
    }
    return;
  }

  const textValue = String(value);
  chargeMultipartBudget(budget, Buffer.byteLength(textValue));
  form.append(key, textValue);
}

export function buildMultipartBody(body: Record<string, unknown>): FormData {
  const form = new FormData();
  const budget: MultipartBudget = { bytes: 0, parts: 0 };
  for (const [key, value] of Object.entries(body)) {
    appendMultipartValue(form, key, value, budget);
  }
  return form;
}
