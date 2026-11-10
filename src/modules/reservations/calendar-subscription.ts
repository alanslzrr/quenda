import { createHash, randomBytes } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
import { calendarFile } from "./icalendar.ts";
import {
  type CalendarRow,
  calendarWording,
  toEvent,
} from "./personal-calendar.ts";

const feedLimit = 100;
/** 32 random bytes, base64url without padding. */
export const subscriptionToken = /^[A-Za-z0-9_-]{43}$/;

export function subscriptionHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest();
}

export function subscriptionUrls(
  origin: string,
  token: string,
  locale: "es" | "gl",
) {
  const url = `${origin}/api/calendars/${token}.ics?lang=${locale}`;
  return { url, webcalUrl: url.replace(/^https?:/, "webcal:") };
}

export async function calendarSubscriptionStatus(
  pool: Pool,
  actor: AuthenticatedAccount,
) {
  const createdAt = await command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) =>
      (
        await client.query<{ created_at: Date | null }>(
          "SELECT domain.calendar_subscription_status() AS created_at",
        )
      ).rows[0]?.created_at ?? null,
  );
  return { active: createdAt !== null, createdAt };
}

/** Creates the subscription or replaces its secret. The URL is returned only here. */
export async function replaceCalendarSubscription(
  pool: Pool,
  actor: AuthenticatedAccount,
  origin: string,
  locale: "es" | "gl",
) {
  const token = randomBytes(32).toString("base64url");
  try {
    const createdAt = await command(
      pool,
      { accountId: actor.accountId, tenantId: null },
      async (client) =>
        (
          await client.query<{ created_at: Date }>(
            "SELECT domain.replace_calendar_subscription($1) AS created_at",
            [subscriptionHash(token)],
          )
        ).rows[0]?.created_at,
    );
    if (!createdAt) throw new Error("Missing subscription instant");
    return { ...subscriptionUrls(origin, token, locale), createdAt };
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "42501")
      throw new HttpError("FORBIDDEN");
    throw error;
  }
}

export async function revokeCalendarSubscription(
  pool: Pool,
  actor: AuthenticatedAccount,
) {
  const revoked = await command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) =>
      (
        await client.query<{ revoked: boolean }>(
          "SELECT domain.revoke_calendar_subscription() AS revoked",
        )
      ).rows[0]?.revoked ?? false,
  );
  return { revoked };
}

/** The subscribed calendar: upcoming confirmed reservations of the account that owns the secret. */
export async function subscribedCalendar(
  pool: Pool,
  token: string,
  origin: string,
  locale: "es" | "gl",
  now: Date = new Date(),
) {
  if (!subscriptionToken.test(token)) throw new HttpError("NOT_FOUND");
  try {
    const rows = await command(pool, undefined, async (client) => {
      return (
        await client.query<CalendarRow>(
          "SELECT * FROM domain.calendar_subscription_reservations($1,$2)",
          [subscriptionHash(token), feedLimit],
        )
      ).rows;
    });
    return calendarFile(
      rows.map((row) => toEvent(row, origin, locale)),
      { name: calendarWording[locale].calendar, stamp: now },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "P0002")
      throw new HttpError("NOT_FOUND");
    throw error;
  }
}
