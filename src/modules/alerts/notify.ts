import type { Transporter } from "nodemailer";
import type { MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
import { sendEmail } from "@/lib/notify/email";
import { postJson } from "@/lib/notify/http";

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
  webhookUrl: string | null;
}

export type NotificationOutcome = "opened" | "still_open" | "resolved";

function subject(incident: NotifiableIncident, outcome: NotificationOutcome): string {
  const prefix = outcome === "resolved" ? "[RESOLVED]" : `[${incident.severity}]`;
  return `${prefix} ${incident.title}${incident.sourceLabel ? ` — ${incident.sourceLabel}` : ""}`;
}

function textBody(incident: NotifiableIncident, outcome: NotificationOutcome, appUrl: string | null): string {
  const lines = [
    outcome === "resolved" ? "This incident has been resolved automatically: the condition no longer breaches the threshold." : `Alert: ${incident.title}`,
  ];
  if (incident.sourceLabel) lines.push(`Source: ${incident.sourceLabel}`);
  if (incident.metric) lines.push(`Metric: ${humanizeMetric(incident.metric)}`);
  if (incident.triggerValue !== null) lines.push(`Current value: ${incident.triggerValue}`);
  if (outcome !== "resolved" && incident.peakValue !== null) lines.push(`Peak value: ${incident.peakValue}`);
  if (appUrl) lines.push("", `${appUrl}/incidents`);
  return lines.join("\n");
}

function slackPayload(incident: NotifiableIncident, outcome: NotificationOutcome, appUrl: string | null) {
  const emoji = outcome === "resolved" ? ":white_check_mark:" : incident.severity === "CRITICAL" ? ":red_circle:" : ":warning:";
  return { text: `${emoji} ${subject(incident, outcome)}\n${textBody(incident, outcome, appUrl)}` };
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
  error?: string;
}

/**
 * Best-effort fan-out to every channel the rule has configured AND actually has a target for
 * (checking a channel with no e-mail/URL filled in is a no-op, not an error). One channel failing
 * never affects the others — see the `Promise.allSettled` below.
 *
 * TEAMS/SMS/PUSH are accepted by the schema and the rule form but not dispatched here yet (no
 * provider wired up — see src/modules/alerts/constants.ts NOTIFICATION_CHANNELS).
 */
export async function dispatchIncidentNotification(
  rule: NotifiableRule,
  incident: NotifiableIncident,
  outcome: NotificationOutcome,
  options: { appUrl?: string | null; emailTransporter?: Transporter } = {},
): Promise<ChannelResult[]> {
  const appUrl = options.appUrl ?? null;
  const jobs: Array<Promise<ChannelResult>> = [];

  if (rule.channels.includes("EMAIL") && rule.notifyEmails.length > 0) {
    jobs.push(
      sendEmail({ to: rule.notifyEmails, subject: subject(incident, outcome), text: textBody(incident, outcome, appUrl) }, options.emailTransporter)
        .then((): ChannelResult => ({ channel: "EMAIL", ok: true }))
        .catch((error: unknown): ChannelResult => ({ channel: "EMAIL", ok: false, error: String(error) })),
    );
  }
  if (rule.channels.includes("SLACK") && rule.webhookUrl) {
    jobs.push(
      postJson(rule.webhookUrl, slackPayload(incident, outcome, appUrl))
        .then((): ChannelResult => ({ channel: "SLACK", ok: true }))
        .catch((error: unknown): ChannelResult => ({ channel: "SLACK", ok: false, error: String(error) })),
    );
  }
  if (rule.channels.includes("WEBHOOK") && rule.webhookUrl) {
    jobs.push(
      postJson(rule.webhookUrl, webhookPayload(incident, outcome))
        .then((): ChannelResult => ({ channel: "WEBHOOK", ok: true }))
        .catch((error: unknown): ChannelResult => ({ channel: "WEBHOOK", ok: false, error: String(error) })),
    );
  }

  return Promise.all(jobs);
}

/** Has enough time passed since the last notification to send another one for the same open incident? */
export function shouldRenotify(lastNotifiedAt: Date | null, cooldownSec: number, now: Date): boolean {
  if (!lastNotifiedAt) return true;
  return now.getTime() - lastNotifiedAt.getTime() >= cooldownSec * 1000;
}
