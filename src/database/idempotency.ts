import { createHash } from "node:crypto";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { HttpError } from "../http/errors.ts";
import { command } from "./command.ts";
import type { TransactionContext } from "./context.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Hash validated, normalized command fields, including resource IDs and revision.
// Arrays preserve order; object property order does not affect the command.
export function commandFingerprint(input: Json): string {
  const encode = (value: Json): string => {
    if (value === null || typeof value !== "object") {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new HttpError("INVALID_INPUT");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(value[key] as Json)}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(encode(input)).digest("hex");
}

interface IdempotentOperation<T extends Json> {
  operation: string;
  key: string;
  input: Json;
  retentionSeconds: number;
  // Must check current access to the target, on every attempt and before replay.
  authorize(client: PoolClient): Promise<void>;
  execute(client: PoolClient): Promise<T>;
}

export async function idempotentCommand<T extends Json>(
  pool: Pool,
  context: TransactionContext,
  options: IdempotentOperation<T>,
): Promise<{ result: T; replayed: boolean; expiresAt: string }> {
  if (
    !context.tenantId ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(options.key) ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(options.operation) ||
    !Number.isSafeInteger(options.retentionSeconds) ||
    options.retentionSeconds < 1 ||
    options.retentionSeconds > 2147483647
  )
    throw new HttpError("INVALID_INPUT");
  const fingerprint = commandFingerprint(options.input);
  const scope = [
    context.tenantId,
    context.accountId,
    options.operation,
    options.key,
  ];
  return command(pool, context, async (client) => {
    await options.authorize(client);
    const previousTimeout = (await client.query("SHOW lock_timeout")).rows[0]
      .lock_timeout as string;
    await client.query("SELECT set_config('lock_timeout','250ms',true)");
    let row: {
      fingerprint: string;
      result: T | null;
      expires_at: Date;
      active: boolean;
      complete: boolean;
    };
    try {
      await client.query(
        `INSERT INTO domain.idempotent_command(tenant_id,actor_id,operation,key,fingerprint,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp()+$6::integer*interval '1 second')
        ON CONFLICT DO NOTHING`,
        [...scope, fingerprint, options.retentionSeconds],
      );
      const selected = await client.query(
        `SELECT fingerprint,result,expires_at,expires_at>clock_timestamp() AS active,result IS NOT NULL AS complete
        FROM domain.idempotent_command WHERE (tenant_id,actor_id,operation,key)=($1,$2,$3,$4) FOR UPDATE`,
        scope,
      );
      row = selected.rows[0];
    } catch (error) {
      if (error instanceof DatabaseError && error.code === "55P03")
        throw new HttpError("CONFLICT");
      throw error;
    }
    await client.query("SELECT set_config('lock_timeout',$1,true)", [
      previousTimeout,
    ]);
    if (row.complete && row.active) {
      if (row.fingerprint !== fingerprint) throw new HttpError("CONFLICT");
      return {
        result: row.result as T,
        replayed: true,
        expiresAt: row.expires_at.toISOString(),
      };
    }
    if (!row.active) {
      const updated = await client.query(
        `UPDATE domain.idempotent_command SET fingerprint=$5,result=NULL,
        created_at=clock_timestamp(),expires_at=clock_timestamp()+$6::integer*interval '1 second'
        WHERE (tenant_id,actor_id,operation,key)=($1,$2,$3,$4) RETURNING expires_at`,
        [...scope, fingerprint, options.retentionSeconds],
      );
      row.expires_at = updated.rows[0].expires_at;
    }
    const result = await options.execute(client);
    const saved = await client.query(
      `UPDATE domain.idempotent_command SET result=$5::jsonb,expires_at=clock_timestamp()+$6::integer*interval '1 second'
      WHERE (tenant_id,actor_id,operation,key)=($1,$2,$3,$4) RETURNING expires_at`,
      [...scope, JSON.stringify(result), options.retentionSeconds],
    );
    return {
      result,
      replayed: false,
      expiresAt: saved.rows[0].expires_at.toISOString(),
    };
  });
}
