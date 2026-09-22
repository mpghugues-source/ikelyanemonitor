const REQUEST_TIMEOUT_MS = 10_000;

/**
 * POST a JSON body to an admin-configured URL (Slack incoming webhook or a generic webhook) and
 * throw unless the endpoint answers 2xx. Bounded by a timeout so one slow/unreachable endpoint
 * cannot stall alert evaluation — callers treat this as best-effort (see src/modules/alerts/notify.ts).
 */
export async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`endpoint responded ${response.status}`);
}
