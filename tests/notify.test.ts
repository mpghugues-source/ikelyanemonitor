import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { dispatchIncidentNotification, shouldRenotify } from "@/modules/alerts/notify";

// sendEmail() reads ALERTS_EMAIL_FROM through the app's single validated env (see src/lib/env.ts),
// which also requires DATABASE_URL/IKELYANE_SECRET_KEY even though this suite never touches a
// database — fill in throwaway values so getEnv() succeeds. Restored in afterAll: leaving a fake
// DATABASE_URL behind would make an integration test file processed by the same Vitest worker
// think a real database is configured (its `enabled` guard just checks the env var is set) instead
// of being skipped.
const savedDatabaseUrl = process.env.DATABASE_URL;
const savedSecretKey = process.env.IKELYANE_SECRET_KEY;
process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:5432/notify_test";
process.env.IKELYANE_SECRET_KEY ??= Buffer.alloc(32).toString("base64");
resetEnvCache();

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedSecretKey === undefined) delete process.env.IKELYANE_SECRET_KEY;
  else process.env.IKELYANE_SECRET_KEY = savedSecretKey;
  resetEnvCache();
});

describe("shouldRenotify", () => {
  it("always notifies the first time", () => {
    expect(shouldRenotify(null, 900, new Date())).toBe(true);
  });

  it("waits out the cooldown before notifying again", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(shouldRenotify(new Date(now.getTime() - 899_000), 900, now)).toBe(false);
    expect(shouldRenotify(new Date(now.getTime() - 900_000), 900, now)).toBe(true);
  });
});

describe("dispatchIncidentNotification", () => {
  let server: Server;
  let serverUrl: string;
  const received: Array<{ path: string; status: number; body: unknown }> = [];
  let nextStatus = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received.push({ path: req.url ?? "", status: nextStatus, body: JSON.parse(raw || "{}") });
        res.writeHead(nextStatus, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const incident = {
    id: "inc_1",
    title: "CPU too high",
    severity: "CRITICAL" as const,
    sourceKind: "HOST" as const,
    sourceLabel: "web01",
    metric: "CPU_USAGE_PERCENT" as const,
    triggerValue: 97,
    peakValue: 99,
  };

  it("dispatches nothing when no channel has a target configured", async () => {
    const results = await dispatchIncidentNotification({ channels: ["EMAIL", "SLACK", "WEBHOOK"], notifyEmails: [], webhookUrl: null }, incident, "opened");
    expect(results).toEqual([]);
  });

  it("sends only the channels selected AND targeted, ignoring EMAIL without recipients", async () => {
    nextStatus = 200;
    received.length = 0;
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const results = await dispatchIncidentNotification(
      { channels: ["EMAIL", "WEBHOOK"], notifyEmails: [], webhookUrl: serverUrl },
      incident,
      "opened",
      { emailTransporter: transporter },
    );

    expect(results).toEqual([{ channel: "WEBHOOK", ok: true }]);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toMatchObject({ outcome: "opened", incidentId: "inc_1", severity: "CRITICAL", sourceLabel: "web01" });
  });

  it("builds a Slack-shaped payload with the incident title and value", async () => {
    nextStatus = 200;
    received.length = 0;
    await dispatchIncidentNotification({ channels: ["SLACK"], notifyEmails: [], webhookUrl: serverUrl }, incident, "opened");

    expect(received).toHaveLength(1);
    const body = received[0]?.body as { text: string };
    expect(body.text).toContain("CPU too high");
    expect(body.text).toContain("web01");
    expect(body.text).toContain("97");
  });

  it("composes and hands the e-mail to the transporter (jsonTransport: no real send)", async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const results = await dispatchIncidentNotification(
      { channels: ["EMAIL"], notifyEmails: ["ops@example.com", "oncall@example.com"], webhookUrl: null },
      incident,
      "resolved",
      { emailTransporter: transporter },
    );

    expect(results).toEqual([{ channel: "EMAIL", ok: true }]);
  });

  it("reports a channel failure without throwing, and does not let it block the others", async () => {
    nextStatus = 500;
    received.length = 0;
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const results = await dispatchIncidentNotification(
      { channels: ["EMAIL", "WEBHOOK"], notifyEmails: ["ops@example.com"], webhookUrl: serverUrl },
      incident,
      "still_open",
      { emailTransporter: transporter },
    );

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.channel === "EMAIL")).toEqual({ channel: "EMAIL", ok: true });
    const webhookResult = results.find((r) => r.channel === "WEBHOOK");
    expect(webhookResult?.ok).toBe(false);
    expect(webhookResult?.error).toContain("500");
  });
});
