import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "@/lib/env";

let transporter: Transporter | undefined;

/**
 * Lazy, process-wide (mirrors src/lib/prisma.ts): building a transporter has no side effects worth
 * repeating per call, and importing this module must stay side-effect free for `next build`/tests.
 */
function getTransporter(): Transporter {
  if (transporter) return transporter;
  const env = getEnv();
  transporter = env.SMTP_URL
    ? nodemailer.createTransport(env.SMTP_URL)
    // No `args` here: nodemailer's default invocation is `-i -f <envelope-from> <to...>`, which is
    // what a locally piped sendmail expects. Passing `-t` on top of that made it fail (`-t` means
    // "read recipients from the headers", conflicting with the recipients nodemailer already
    // passes on argv) — caught by the real end-to-end send in scripts/smoke-test-notify.ts.
    : nodemailer.createTransport({ sendmail: true, newline: "unix", path: "/usr/sbin/sendmail" });
  return transporter;
}

export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text: string;
}

/**
 * Send one e-mail. Nodemailer builds the MIME message and escapes headers — never hand-compose a
 * raw message from rule/incident text, which is admin-authored but still worth not trusting blindly
 * (header injection via a newline in a subject, for instance).
 *
 * `transporterOverride` exists for tests (nodemailer's zero-network `jsonTransport`); production
 * callers never pass it.
 */
export async function sendEmail(message: EmailMessage, transporterOverride?: Transporter): Promise<void> {
  const env = getEnv();
  await (transporterOverride ?? getTransporter()).sendMail({
    from: env.ALERTS_EMAIL_FROM,
    to: message.to.join(", "),
    subject: message.subject,
    text: message.text,
  });
}
