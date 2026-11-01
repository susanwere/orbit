import { validateProjectContextAttributes } from "./typed-project-context.js";
import {
  DomainError,
  type ContextChangeOperation,
  type JsonValue,
  type ProjectContext,
  type ProjectContextPreview,
} from "@orbit/domain";

const IMMUTABLE_ROOTS = new Set(["projectId", "originalIntentId", "workflowReviews"]);
const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePointer(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new DomainError(
      "invalid_context_path",
      `Context mutation path must be a JSON Pointer: ${path}`,
    );
  }

  const segments = path.slice(1).split("/").map(decodePointerSegment);

  if (segments.length === 0 || segments[0] === "") {
    throw new DomainError("invalid_context_path", "Context root cannot be mutated.");
  }

  if (segments.some((segment) => UNSAFE_POINTER_SEGMENTS.has(segment))) {
    throw new DomainError("invalid_context_path", `Unsafe context mutation path: ${path}`);
  }

  if (IMMUTABLE_ROOTS.has(segments[0]!)) {
    throw new DomainError("immutable_context_path", `Context path /${segments[0]} is immutable.`);
  }

  return segments;
}

function matchesAllowedPath(path: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => {
    if (allowed.endsWith("/**")) {
      const prefix = allowed.slice(0, -3);
      return path === prefix || path.startsWith(`${prefix}/`);
    }
    return path === allowed;
  });
}

export function assertContextOperationAllowed(
  operation: ContextChangeOperation,
  allowedPaths: readonly string[],
): void {
  parsePointer(operation.path);

  if (!matchesAllowedPath(operation.path, allowedPaths)) {
    throw new DomainError(
      "context_path_not_allowed",
      `Context mutation path is outside the allowed proposal scope: ${operation.path}`,
    );
  }

  if (operation.path === "/constraints/-" && operation.op !== "add") {
    throw new DomainError(
      "invalid_context_operation",
      "The append constraint path only supports add.",
    );
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setObjectValue(
  object: Record<string, unknown>,
  key: string,
  operation: ContextChangeOperation,
): void {
  if (operation.op === "remove") {
    if (!(key in object)) {
      throw new DomainError(
        "context_path_not_found",
        `Cannot remove missing context path: ${operation.path}`,
      );
    }
    delete object[key];
    return;
  }

  if (operation.op === "replace" && !(key in object)) {
    throw new DomainError(
      "context_path_not_found",
      `Cannot replace missing context path: ${operation.path}`,
    );
  }

  object[key] = cloneJson(operation.value);
}

function applyOperation(
  document: Record<string, unknown>,
  operation: ContextChangeOperation,
): void {
  const segments = parsePointer(operation.path);
  let cursor: unknown = document;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new DomainError(
        "context_path_not_found",
        `Cannot traverse context path: ${operation.path}`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  const leaf = segments.at(-1)!;

  if (Array.isArray(cursor)) {
    if (leaf === "-") {
      if (operation.op !== "add") {
        throw new DomainError(
          "invalid_context_operation",
          `Only add is valid for array append path: ${operation.path}`,
        );
      }
      cursor.push(cloneJson(operation.value));
      return;
    }

    const arrayIndex = Number(leaf);
    if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
      throw new DomainError(
        "context_path_not_found",
        `Invalid array index in context path: ${operation.path}`,
      );
    }

    if (operation.op === "remove") {
      cursor.splice(arrayIndex, 1);
    } else {
      cursor[arrayIndex] = cloneJson(operation.value);
    }
    return;
  }

  if (typeof cursor !== "object" || cursor === null) {
    throw new DomainError(
      "context_path_not_found",
      `Cannot mutate context path: ${operation.path}`,
    );
  }

  setObjectValue(cursor as Record<string, unknown>, leaf, operation);
}

export function applyContextChangeOperations(
  baseContext: ProjectContext,
  operations: readonly ContextChangeOperation[],
  allowedPaths: readonly string[],
): ProjectContextPreview {
  const preview = cloneJson(baseContext) as unknown as Record<string, unknown>;

  for (const operation of operations) {
    assertContextOperationAllowed(operation, allowedPaths);
    applyOperation(preview, operation);
  }

  // Immutable identity fields must survive every proposal exactly.
  if (
    preview.projectId !== baseContext.projectId ||
    preview.originalIntentId !== baseContext.originalIntentId
  ) {
    throw new DomainError(
      "immutable_context_path",
      "A context proposal attempted to change immutable project intent identity.",
    );
  }

  validateProjectContextAttributes(preview as unknown as ProjectContext);
  return preview as unknown as ProjectContextPreview;
}

export function asJsonValue(value: unknown): JsonValue {
  return cloneJson(value) as JsonValue;
}
