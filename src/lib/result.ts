/**
 * Explicit success/failure values for business operations.
 *
 * Expected failures ("not allowed", "email already used") are RETURNED, never thrown: callers must
 * handle them, and the error code is a stable identifier that the UI maps to a translated message.
 * Exceptions are reserved for unexpected faults (database down, bug).
 */
export type Result<T, E extends string = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const fail = <E extends string>(error: E): { ok: false; error: E } => ({ ok: false, error });
