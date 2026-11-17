import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { defaultIdempotencyRetentionSeconds } from "../../config.ts";
import { command } from "../../database/command.ts";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { requireOperator } from "./operator.ts";
import { requireRecentMfa } from "./reauthentication.ts";

/** Tells a refused operator command on an unknown municipality from one refused by its state. */
export async function municipalityExists(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM domain.municipality WHERE id=$1",
    [tenantId],
  );
  return Boolean(result.rowCount);
}

export interface MunicipalityInput {
  name: string;
  timezone: string;
  administratorId: string;
  invitationExpiresAt: string;
}

export async function createMunicipality(
  pool: Pool,
  actor: AuthenticatedAccount,
  input: MunicipalityInput,
  key: string = randomUUID(),
  retentionSeconds = defaultIdempotencyRetentionSeconds,
) {
  const name = input.name.trim();
  if (
    !name ||
    name.length > 200 ||
    !input.administratorId ||
    !Number.isFinite(Date.parse(input.invitationExpiresAt))
  )
    throw new HttpError("INVALID_INPUT");
  if (/^[+-]/.test(input.timezone)) throw new HttpError("INVALID_INPUT");
  try {
    new Intl.DateTimeFormat("es", { timeZone: input.timezone });
  } catch {
    throw new HttpError("INVALID_INPUT");
  }
  const tenantId = randomUUID();
  const invitationId = randomUUID();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId: null },
      {
        operation: "municipality.create",
        key,
        retentionSeconds,
        input: {
          ...input,
          name,
          invitationExpiresAt: new Date(
            input.invitationExpiresAt,
          ).toISOString(),
        },
        authorize: (client) => requireOperator(client, actor),
        execute: async (client) => {
          await client.query("SELECT set_config('quenda.tenant_id',$1,true)", [
            tenantId,
          ]);
          const valid = await client.query<{ valid: boolean }>(
            "SELECT $1::timestamptz > now() AS valid",
            [input.invitationExpiresAt],
          );
          if (!valid.rows[0]?.valid) throw new HttpError("INVALID_INPUT");
          await client.query(
            "INSERT INTO domain.municipality (id, name, timezone) VALUES ($1, $2, $3)",
            [tenantId, name, input.timezone],
          );
          await client.query(
            "INSERT INTO domain.administrator_invitation (tenant_id, id, account_id, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5)",
            [
              tenantId,
              invitationId,
              input.administratorId,
              actor.accountId,
              input.invitationExpiresAt,
            ],
          );
          for (const operation of [
            "CREATE_MUNICIPALITY",
            "INVITE_ADMINISTRATOR",
          ]) {
            await client.query(
              "INSERT INTO domain.identity_event (tenant_id, id, actor_id, operation, subject_id, invitation_id) VALUES ($1, $2, $3, $4, $5, $6)",
              [
                tenantId,
                randomUUID(),
                actor.accountId,
                operation,
                input.administratorId,
                invitationId,
              ],
            );
          }
          await client.query("SELECT set_config('quenda.tenant_id','',true)");
          return { tenantId, invitationId };
        },
      },
    ).then(({ result }) => result);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}

export async function acceptAdministratorInvitation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  invitationId: string,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      requireRecentMfa(actor);
      const authority = await client.query<{ allowed: boolean }>(
        "SELECT domain.lock_invitation_authority($1) AS allowed",
        [invitationId],
      );
      if (!authority.rows[0]?.allowed) throw new HttpError("NOT_FOUND");
      const invitation = await client.query<{ valid: boolean }>(
        "SELECT expires_at > now() AND (role_expires_at IS NULL OR role_expires_at > now()) AND accepted_at IS NULL AND revoked_at IS NULL AS valid FROM domain.administrator_invitation WHERE tenant_id = $1 AND id = $2 AND account_id = $3 FOR UPDATE",
        [tenantId, invitationId, actor.accountId],
      );
      if (!invitation.rows[0]?.valid) throw new HttpError("NOT_FOUND");
      await client.query(
        "INSERT INTO domain.municipal_profile (tenant_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [tenantId, actor.accountId],
      );
      const activated = await client
        .query<{ allowed: boolean }>(
          "SELECT domain.activate_administrator($1) AS allowed",
          [invitationId],
        )
        .catch((error: unknown) => {
          if (
            error instanceof DatabaseError &&
            error.code === "P0001" &&
            error.message === "HANDOVER_REQUIRED"
          )
            throw new HttpError("ACCOUNT_HANDOVER_REQUIRED");
          throw error;
        });
      if (!activated.rows[0]?.allowed) {
        const current = await client.query<{ active: boolean }>(
          "SELECT domain.current_is_administrator() AS active",
        );
        throw new HttpError(
          current.rows[0]?.active ? "ROLE_ALREADY_ACTIVE" : "CONFLICT",
        );
      }
      await client.query(
        "UPDATE domain.administrator_invitation SET accepted_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenantId, invitationId],
      );
      await client.query(
        "INSERT INTO domain.identity_event (tenant_id, id, actor_id, operation, subject_id, invitation_id) VALUES ($1, $2, $3, 'ACCEPT_ADMINISTRATOR', $3, $4)",
        [tenantId, randomUUID(), actor.accountId, invitationId],
      );
      return { tenantId };
    },
  );
}

export async function replaceInitialAdministratorInvitation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: { accountId: string; expiresAt: string; reason: string },
) {
  const reason = input.reason.trim();
  if (
    !reason ||
    reason.length > 500 ||
    !Number.isFinite(Date.parse(input.expiresAt))
  )
    throw new HttpError("INVALID_INPUT");
  const invitationId = randomUUID();
  try {
    return await command(
      pool,
      { accountId: actor.accountId, tenantId },
      async (client) => {
        await requireOperator(client, actor);
        const future = await client.query<{ valid: boolean }>(
          "SELECT $1::timestamptz > now() AS valid",
          [input.expiresAt],
        );
        if (!future.rows[0]?.valid) throw new HttpError("INVALID_INPUT");
        const result = await client.query<{ allowed: boolean }>(
          "SELECT domain.replace_initial_invitation($1,$2,$3,$4) AS allowed",
          [input.accountId, input.expiresAt, reason, invitationId],
        );
        if (!result.rows[0]?.allowed)
          throw new HttpError(
            (await municipalityExists(client, tenantId))
              ? "MUNICIPALITY_ALREADY_INITIALIZED"
              : "NOT_FOUND",
          );
        return { tenantId, invitationId };
      },
    );
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503")
      throw new HttpError("INVALID_INPUT");
    throw error;
  }
}
