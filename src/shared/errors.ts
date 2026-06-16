/**
 * Typegraph Error
 *
 * Custom error class for typegraph-mcp.
 * Provides structured error handling with error codes and recovery hints.
 */

export type ErrorCode =
  | "E_NO_TSCONFIG"
  | "E_NO_PACKAGE_JSON"
  | "E_TYPESCRIPT_NOT_FOUND"
  | "E_TSSERVER_FAILED"
  | "E_PARSE_FAILED"
  | "E_RESOLVE_FAILED"
  | "E_MCP_REGISTRATION_FAILED"
  | "E_CONFIG_INVALID"
  | "E_FILE_NOT_FOUND"
  | "E_PERMISSION_DENIED";

export class TypegraphError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = true,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "TypegraphError";
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      recoverable: this.recoverable,
      hint: this.hint,
    };
  }
}

export function createError(
  code: ErrorCode,
  message: string,
  hint?: string,
): TypegraphError {
  return new TypegraphError(message, code, true, hint);
}

export function createFatalError(
  code: ErrorCode,
  message: string,
  hint?: string,
): TypegraphError {
  return new TypegraphError(message, code, false, hint);
}
