import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { postJson, webhookUrlAllowed } from "@/lib/notify/http";
import { dispatchIncidentNotification, type NotifiableRule, shouldRenotify } from "@/modules/alerts/notify";

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
        if (req.url === "/redirect") {
          received.push({ path: req.url, status: 307, body: JSON.parse(raw || "{}") });
          res.writeHead(307, { location: "/followed" });
          return res.end();
        }
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

  const rule = (overrides: Partial<NotifiableRule>): NotifiableRule => ({
    channels: [], notifyEmails: [], slackWebhookUrl: null, teamsWebhookUrl: null, webhookUrl: null, ...overrides,
  });
  // The test server listens on loopback, which the SSRF guard refuses by default.
  const local = { allowPrivateTargets: true };

  it("dispatches nothing when no channel has a target configured", async () => {
    const results = await dispatchIncidentNotification(rule({ channels: ["EMAIL", "SLACK", "TEAMS", "WEBHOOK"] }), incident, "opened");
    expect(results).toEqual([]);
  });

  it("sends only the channels selected AND targeted, ignoring EMAIL without recipients", async () => {
    nextStatus = 200;
    received.length = 0;
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const results = await dispatchIncidentNotification(
      rule({ channels: ["EMAIL", "WEBHOOK"], webhookUrl: serverUrl, slackWebhookUrl: `${serverUrl}/slack` }),
      incident,
      "opened",
      { emailTransporter: transporter, ...local },
    );

    expect(results).toEqual([{ channel: "WEBHOOK", ok: true }]);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toMatchObject({ outcome: "opened", incidentId: "inc_1", severity: "CRITICAL", sourceLabel: "web01" });
  });

  it("posts each chat channel to its OWN URL with its own payload shape", async () => {
    nextStatus = 200;
    received.length = 0;
    const results = await dispatchIncidentNotification(
      rule({ channels: ["SLACK", "TEAMS", "WEBHOOK"], slackWebhookUrl: `${serverUrl}/slack`, teamsWebhookUrl: `${serverUrl}/teams`, webhookUrl: `${serverUrl}/hook` }),
      incident,
      "opened",
      { appUrl: "https://monitor.example.com", ...local },
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const byPath = Object.fromEntries(received.map((r) => [r.path, r.body]));
    expect(Object.keys(byPath).sort()).toEqual(["/hook", "/slack", "/teams"]);

    const slack = byPath["/slack"] as { text: string };
    expect(slack.text).toContain("CPU too high");
    expect(slack.text).toContain("web01");
    expect(slack.text).toContain("97");

    const teams = byPath["/teams"] as { type: string; attachments: Array<{ contentType: string; content: { type: string; body: Array<Record<string, unknown>>; actions: Array<{ url: string }> } }> };
    expect(teams.type).toBe("message");
    expect(teams.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    const card = teams.attachments[0]!.content;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body[0]).toMatchObject({ text: "[CRITICAL] CPU too high — web01", color: "Attention" });
    expect(card.body.find((block) => block.type === "FactSet")).toMatchObject({ facts: expect.arrayContaining([{ title: "Peak value", value: "99" }]) });
    expect(card.actions[0]?.url).toBe("https://monitor.example.com/incidents");

    expect(byPath["/hook"]).toMatchObject({ outcome: "opened", incidentId: "inc_1" });
  });

  it("labels a test send as such", async () => {
    nextStatus = 200;
    received.length = 0;
    await dispatchIncidentNotification(rule({ channels: ["SLACK"], slackWebhookUrl: serverUrl }), incident, "test", local);
    expect((received[0]?.body as { text: string }).text).toMatch(/^:test_tube: \[TEST\] CPU too high/);
  });

  it("composes and hands the e-mail to the transporter (jsonTransport: no real send)", async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const results = await dispatchIncidentNotification(
      rule({ channels: ["EMAIL"], notifyEmails: ["ops@example.com", "oncall@example.com"] }),
      incident,
      "resolved",
      { emailTransporter: transporter },
    );

    expect(results).toEqual([{ channel: "EMAIL", ok: true }]);
  });

  it("reports a channel failure with a stable code, without throwing or blocking the others", async () => {
    nextStatus = 500;
    received.length = 0;
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const results = await dispatchIncidentNotification(
      rule({ channels: ["EMAIL", "WEBHOOK"], notifyEmails: ["ops@example.com"], webhookUrl: serverUrl }),
      incident,
      "still_open",
      { emailTransporter: transporter, ...local },
    );

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.channel === "EMAIL")).toEqual({ channel: "EMAIL", ok: true });
    const webhookResult = results.find((r) => r.channel === "WEBHOOK");
    expect(webhookResult).toMatchObject({ ok: false, code: "http_status" });
    expect(webhookResult?.error).toContain("500");
  });

  it("refuses loopback/private webhook targets by default (SSRF) — nothing reaches the server", async () => {
    nextStatus = 200;
    received.length = 0;
    const results = await dispatchIncidentNotification(
      rule({ channels: ["SLACK", "TEAMS", "WEBHOOK"], slackWebhookUrl: serverUrl, teamsWebhookUrl: serverUrl.replace("127.0.0.1", "localhost"), webhookUrl: "http://169.254.169.254/latest/meta-data" }),
      incident,
      "opened",
    );
    expect(results.map((r) => [r.channel, r.ok, r.code])).toEqual([
      ["SLACK", false, "blocked_target"],
      ["TEAMS", false, "blocked_target"],
      ["WEBHOOK", false, "blocked_target"],
    ]);
    expect(received).toHaveLength(0);
  });

  it("does not follow redirects (a public URL must not bounce the POST to an internal one)", async () => {
    received.length = 0;
    await expect(postJson(`${serverUrl}/redirect`, { a: 1 }, local)).rejects.toMatchObject({ code: "redirect" });
    expect(received.map((r) => r.path)).toEqual(["/redirect"]);
  });
});

describe("webhookUrlAllowed (save-time check)", () => {
  it("accepts public http(s) URLs", () => {
    expect(webhookUrlAllowed("https://hooks.slack.com/services/T0/B0/x", false)).toBe(true);
    expect(webhookUrlAllowed("https://prod-12.westeurope.logic.azure.com/workflows/abc", false)).toBe(true);
    expect(webhookUrlAllowed("http://8.8.8.8/hook", false)).toBe(true);
  });

  it("refuses other schemes, private/loopback literals and localhost", () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "http://127.0.0.1:5441", "http://[::1]/", "http://10.0.0.5/", "http://169.254.169.254/", "http://localhost:3020/", "http://api.localhost/", "not a url"]) {
      expect(webhookUrlAllowed(url, false), url).toBe(false);
    }
  });

  it("allows private targets only when the install opts in", () => {
    expect(webhookUrlAllowed("http://10.0.0.5/hook", true)).toBe(true);
    expect(webhookUrlAllowed("ftp://10.0.0.5/hook", true)).toBe(false);
  });
});
