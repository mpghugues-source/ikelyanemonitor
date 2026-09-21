/**
 * An error that maps to an HTTP response of the telemetry API. `code` is a stable, machine-readable
 * identifier for agents; `message` is human-readable English (the API is consumed by software,
 * so it is not localized).
 */
export class TelemetryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TelemetryHttpError";
  }
}
