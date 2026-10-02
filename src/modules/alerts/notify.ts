import type { Transporter } from "nodemailer";
import type { MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
import { sendEmail } from "@/lib/notify/email";
import { postJson, WebhookError, type WebhookErrorCode } from "@/lib/notify/http";

/** "CPU_USAGE_PERCENT" -> "cpu usage percent" — good enough for a plain-text ops notification. */
function humanizeMetric(metric: MetricType): string {
  return metric.toLowerCase().replaceAll("_", " ");
}

export interface NotifiableIncident {
  id: string;
  title: string;
  severity: Severity;
  sourceKind: MetricSource | null;
  sourceLabel: string | null;
  metric: MetricType | null;
  triggerValue: number | null;
  peakValue: number | null;
}

export interface NotifiableRule {
  channels: readonly NotificationChannel[];
  notifyEmails: readonly string[];
  slackWebhookUrl: string | null;
  teamsWebhookUrl: string | null;
  webhookUrl: string | null;
}

/** "test" = sent from the rule's "Send a test" button, never by the evaluation engine. */
export type NotificationOutcome = "opened" | "still_open" | "resolved" | "test";

function subject(incident: NotifiableIncident, outcome: NotificationOutcome): string {
  const prefix = outcome === "resolved" ? "[RESOLVED]" : outcome === "test" ? "[TEST]" : `[${incident.severity}]`;
  return `${prefix} ${incident.title}${incident.sourceLabel ? ` — ${incident.sourceLabel}` : ""}`;
}

function headline(incident: NotifiableIncident, outcome: NotificationOutcome): string {
  if (outcome === "resolved") return "This incident has been resolved automatically: the condition no longer breaches the threshold.";
  if (outcome === "test") return `Test notification for the alert rule "${incident.title}" — no incident is open, nothing to do.`;
  return `Alert: ${incident.title}`;
}

function textBody(incident: NotifiableIncident, outcome: NotificationOutcome, appUrl: string | null): string {
  const lines = [headline(incident, outcome)];
  if (incident.sourceLabel) lines.push(`Source: ${incident.sourceLabel}`);
  if (incident.metric) lines.push(`Metric: ${humanizeMetric(incident.metric)}`);
  if (incident.triggerValue !== null) lines.push(`Current value: ${incident.triggerValue}`);
  if ((outcome === "opened" || outcome === "still_open") && incident.peakValue !== null) lines.push(`Peak value: ${incident.peakValue}`);
  if (appUrl) lines.push("", `${appUrl}/incidents`);
  return lines.join("\n");
}

function slackPayload(incident: NotifiableIncident, outcome: NotificationOutcome, appUrl: string | null) {
  const emoji = outcome === "resolved" ? ":white_check_mark:" : outcome === "test" ? ":test_tube:" : incident.severity === "CRITICAL" ? ":red_circle:" : ":warning:";
  return { text: `${emoji} ${subject(incident, outcome)}\n${textBody(incident, outcome, appUrl)}` };
}

/**
 * Microsoft Teams: an Adaptive Card in the message envelope that Teams Workflows ("Post to a channel when a
 * webhook request is received") expects. The legacy Office 365 connectors are retired; Workflows answer 202.
 */
export function teamsPayload(incident: NotifiableIncident, outcome: NotificationOutcome, appUrl: string | null) {
  const color = outcome === "resolved" ? "Good" : outcome === "test" ? "Accent" : incident.severity === "CRITICAL" ? "Attention" : "Warning";
  const facts: Array<{ title: string; value: string }> = [];
  if (incident.sourceLabel) facts.push({ title: "Source", value: incident.sourceLabel });
  if (incident.metric) facts.push({ title: "Metric", value: humanizeMetric(incident.metric) });
  if (incident.triggerValue !== null) facts.push({ title: "Current value", value: String(incident.triggerValue) });
  if ((outcome === "opened" || outcome === "still_open") && incident.peakValue !== null) facts.push({ title: "Peak value", value: String(incident.peakValue) });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: subject(incident, outcome), weight: "Bolder", size: "Medium", color, wrap: true },
            { type: "TextBlock", text: headline(incident, outcome), wrap: true },
            ...(facts.length > 0 ? [{ type: "FactSet", facts }] : []),
          ],
          actions: appUrl ? [{ type: "Action.OpenUrl", title: "Open incidents", url: `${appUrl}/incidents` }] : [],
        },
      },
    ],
  };
}

function webhookPayload(incident: NotifiableIncident, outcome: NotificationOutcome) {
  return {
    outcome,
    incidentId: incident.id,
    title: incident.title,
    severity: incident.severity,
    sourceKind: incident.sourceKind,
    sourceLabel: incident.sourceLabel,
    metric: incident.metric,
    triggerValue: incident.triggerValue,
    peakValue: incident.peakValue,
  };
}

export interface ChannelResult {
  channel: NotificationChannel;
  ok: boolean;
  /** Stable code for the UI ("smtp" = the mail could not be handed over). */
  code?: WebhookErrorCode | "smtp";
  /** Technical hint (HTTP status, DNS code…) — never a secret: webhook URLs are not echoed. */
  error?: string;
}

function failed(channel: NotificationChannel, error: unknown): ChannelResult {
  if (error instanceof WebhookError) return { channel, ok: false, code: error.code, error: error.message };
  return { channel, ok: false, code: channel === "EMAIL" ? "smtp" : "connection", error: String(error) };
}

/**
 * Best-effort fan-out to every channel the rule has configured AND actually has a target for
 * (checking a channel with no e-mail/URL filled in is a no-op, not an error). One channel failing
 * never affects the others: each job catches its own failure, so the `Promise.all` below never rejects.
 *
 * Webhooks only reach public addresses unless `allowPrivateTargets` (WEBHOOKS_ALLOW_PRIVATE_TARGETS) — see
 * src/lib/notify/http.ts. SMS/PUSH have no provider wired up yet (UNAVAILABLE_NOTIFICATION_CHANNELS).
 */
export async function dispatchIncidentNotification(
  rule: NotifiableRule,
  incident: NotifiableIncident,
  outcome: NotificationOutcome,
  options: { appUrl?: string | null; emailTransporter?: Transporter; allowPrivateTargets?: boolean } = {},
): Promise<ChannelResult[]> {
  const appUrl = options.appUrl ?? null;
  const http = { allowPrivateTargets: options.allowPrivateTargets ?? false };
  const jobs: Array<Promise<ChannelResult>> = [];

  if (rule.channels.includes("EMAIL") && rule.notifyEmails.length > 0) {
    jobs.push(
      sendEmail({ to: rule.notifyEmails, subject: subject(incident, outcome), text: textBody(incident, outcome, appUrl) }, options.emailTransporter)
        .then((): ChannelResult => ({ channel: "EMAIL", ok: true }))
        .catch((error: unknown) => failed("EMAIL", error)),
    );
  }
  const webhooks: Array<[NotificationChannel, string | null, unknown]> = [
    ["SLACK", rule.slackWebhookUrl, slackPayload(incident, outcome, appUrl)],
    ["TEAMS", rule.teamsWebhookUrl, teamsPayload(incident, outcome, appUrl)],
    ["WEBHOOK", rule.webhookUrl, webhookPayload(incident, outcome)],
  ];
  for (const [channel, url, payload] of webhooks) {
    if (!rule.channels.includes(channel) || !url) continue;
    jobs.push(
      postJson(url, payload, http)
        .then((): ChannelResult => ({ channel, ok: true }))
        .catch((error: unknown) => failed(channel, error)),
    );
  }

  return Promise.all(jobs);
}

/** Has enough time passed since the last notification to send another one for the same open incident? */
export function shouldRenotify(lastNotifiedAt: Date | null, cooldownSec: number, now: Date): boolean {
  if (!lastNotifiedAt) return true;
  return now.getTime() - lastNotifiedAt.getTime() >= cooldownSec * 1000;
}
