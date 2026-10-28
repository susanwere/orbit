import { createHash } from "node:crypto";
import type { ProjectContext } from "@orbit/domain";

function canonicalize(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError(`Canonical JSON does not support undefined at key "${key}".`);
      }
      return `${JSON.stringify(key)}:${canonicalize(item)}`;
    });
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Canonical JSON does not support values of type ${typeof value}.`);
}

export function serializeProjectContext(context: ProjectContext): string {
  return canonicalize(context);
}

export function hashProjectContext(context: ProjectContext): string {
  return createHash("sha256")
    .update(serializeProjectContext(context), "utf8")
    .digest("hex");
}
