import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { civilDate } from "../../shared/civil-date.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireOperator } from "./operator.ts";

export const noticeKinds = ["privacy", "legal", "accessibility"] as const;
export type NoticeKind = (typeof noticeKinds)[number];

// The municipality writes these texts; the platform supplies only the structure.
// Fixed field lists keep the pages comparable and rule out markup or links in free text.
export const noticeFields: Record<NoticeKind, readonly string[]> = {
  privacy: [
    "controller",
    "controllerContact",
    "dpo",
    "purposes",
    "legalBasis",
    "recipients",
    "retention",
    "rights",
    "complaint",
  ],
  legal: ["entity", "taxId", "address", "contact", "notes"],
  accessibility: ["nonAccessible", "evaluation", "feedback", "enforcement"],
};
export const conformanceStatuses = ["full", "partial", "none"] as const;
const languages = ["gl", "es"] as const;
const maxText = 4000;
// Below the 65,536-byte storage bound, so an oversized text is a validation
// error and never a rejected insert.
const maxBodyBytes = 60000;

export interface NoticeBody {
  gl?: Record<string, string>;
  es?: Record<string, string>;
  status?: (typeof conformanceStatuses)[number];
  preparedOn?: string;
  reviewedOn?: string;
}
export interface PublicNotice {
  kind: NoticeKind;
  version: number;
  body: NoticeBody;
  publishedAt: string | null;
}

/** Trims every text, drops what is blank and rejects fields the kind does not define. */
export function normalizeNotice(
  kind: NoticeKind,
  input: NoticeBody,
): NoticeBody {
  const allowed = noticeFields[kind];
  const body: NoticeBody = {};
  for (const language of languages) {
    const values = input[language];
    if (values === undefined) continue;
    const clean: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      if (!allowed.includes(field) || typeof value !== "string")
        throw new HttpError("INVALID_INPUT");
      const text = value.trim();
      if (text.length > maxText) throw new HttpError("INVALID_INPUT");
      if (text) clean[field] = text;
    }
    if (Object.keys(clean).length) body[language] = clean;
  }
  if (kind === "accessibility") {
    if (input.status !== undefined) {
      if (!conformanceStatuses.includes(input.status))
        throw new HttpError("INVALID_INPUT");
      body.status = input.status;
    }
    for (const field of ["preparedOn", "reviewedOn"] as const) {
      const value = input[field];
      if (value === undefined) continue;
      civilDate(value);
      body[field] = value;
    }
    if (body.preparedOn && body.reviewedOn && body.reviewedOn < body.preparedOn)
      throw new HttpError("INVALID_INPUT");
  } else if (
    input.status !== undefined ||
    input.preparedOn !== undefined ||
    input.reviewedOn !== undefined
  )
    throw new HttpError("INVALID_INPUT");
  if (
    !Object.keys(body).length ||
    Buffer.byteLength(JSON.stringify(body)) > maxBodyBytes
  )
    throw new HttpError("INVALID_INPUT");
  return body;
}

export async function publicNotice(
  pool: Pool,
  tenantId: string | null,
  kind: NoticeKind,
): Promise<PublicNotice> {
  const row = (
    await pool.query<{
      version: number;
      body: NoticeBody;
      published_at: Date | null;
    }>("SELECT * FROM domain.public_legal_notice($1,$2)", [tenantId, kind])
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    kind,
    version: row.version,
    body: row.body,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

/** Publishes a new version of one text. `expectedVersion` is the version the author read (0 for none). */
export async function saveNotice(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string | null,
  kind: NoticeKind,
  input: { expectedVersion: number; body: NoticeBody },
  correlationId: string = randomUUID(),
): Promise<{ kind: NoticeKind; version: number }> {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2147483647 ||
    !noticeKinds.includes(kind)
  )
    throw new HttpError("INVALID_INPUT");
  const body = normalizeNotice(kind, input.body);
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      if (tenantId === null) await requireOperator(client, actor);
      else await requireAdministrator(client, actor);
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.save_legal_notice($1,$2,$3,$4,$5) AS version",
          [
            tenantId,
            kind,
            input.expectedVersion,
            JSON.stringify(body),
            correlationId,
          ],
        )
      ).rows[0];
      if (!row?.version) throw new HttpError("CONFLICT");
      return { kind, version: row.version };
    },
  );
}
