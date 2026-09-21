import type { Db } from "@/lib/auth/db";
import {
  LOGIN_MAX_FAILURES_PER_EMAIL,
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_WINDOW_SECONDS,
} from "@/lib/auth/constants";

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Seconds until a counter of failures falls back under `max`, given the failures inside the
 * window sorted oldest-first. 0 means "not blocked".
 *
 * With n ≥ max failures, the count drops below max once the (n − max + 1) oldest have aged out —
 * i.e. when failure number (n − max) leaves the window.
 */
export function secondsUntilUnblocked(failureTimesAsc: Date[], max: number, now: Date): number {
  if (failureTimesAsc.length < max) return 0;
  const pivot = failureTimesAsc[failureTimesAsc.length - max];
  return Math.max(1, Math.ceil((pivot.getTime() + LOGIN_WINDOW_SECONDS * 1000 - now.getTime()) / 1000));
}

/**
 * May this sign-in attempt proceed? Two independent limits: failures for the e-mail address (stops
 * password guessing against one account) and failures from the source address (stops one machine
 * spraying many accounts). Attempts are recorded for unknown e-mails too, so throttling does not
 * reveal which accounts exist.
 *
 * Note the trade-off: an attacker can lock a victim's account by failing on purpose. The window is
 * short (15 minutes) and the legitimate user keeps access from a browser that already has a session.
 */
export async function checkLoginThrottle(
  db: Db,
  email: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<ThrottleDecision> {
  const since = new Date(now.getTime() - LOGIN_WINDOW_SECONDS * 1000);

  const emailFailures = await db.loginAttempt.findMany({
    where: { email, success: false, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
    take: 500,
  });
  const ipFailures = ip
    ? await db.loginAttempt.findMany({
        where: { ipAddress: ip, success: false, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
        take: 500,
      })
    : [];

  const wait = Math.max(
    secondsUntilUnblocked(emailFailures.map((f) => f.createdAt), LOGIN_MAX_FAILURES_PER_EMAIL, now),
    secondsUntilUnblocked(ipFailures.map((f) => f.createdAt), LOGIN_MAX_FAILURES_PER_IP, now),
  );
  return wait > 0 ? { allowed: false, retryAfterSeconds: wait } : { allowed: true };
}

export async function recordLoginAttempt(
  db: Db,
  attempt: { email: string; ip: string | null; success: boolean; now?: Date },
): Promise<void> {
  await db.loginAttempt.create({
    data: {
      email: attempt.email,
      ipAddress: attempt.ip,
      success: attempt.success,
      ...(attempt.now ? { createdAt: attempt.now } : {}),
    },
  });
}

/** A successful sign-in clears the account's failure streak. */
export async function clearEmailFailures(db: Db, email: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email, success: false } });
}

/** Attempts are only useful inside the window; keep the table small. */
export async function purgeOldAttempts(db: Db, now: Date = new Date()): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
}
