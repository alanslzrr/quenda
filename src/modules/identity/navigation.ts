import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import type { Operation } from "./manager.ts";

export interface PublicMunicipality {
  id: string;
  name: string;
  timeZone: string;
  officialName: string;
  /** Which logos exist; version changes with every name or logo change and addresses the current image. */
  branding: { version: number; logos: { light: boolean; dark: boolean } };
}
export interface MunicipalContext {
  id: string;
  name: string;
  administrator: boolean;
  permissions: Array<{ operation: Operation; unitId: string | null }>;
}
function page<T extends { id: string }>(rows: T[]) {
  return {
    items: rows.slice(0, 20),
    nextCursor: rows.length > 20 ? (rows[19]?.id ?? null) : null,
  };
}
export async function publicMunicipalities(
  pool: Pool,
  after: string | null = null,
  selected: string | null = null,
) {
  const result = await pool.query<{
    id: string;
    name: string;
    timezone: string;
    official_name: string;
    branding_version: number;
    light_logo: boolean;
    dark_logo: boolean;
  }>("SELECT * FROM domain.public_municipalities($1,$2)", [after, selected]);
  if (selected && result.rows.length === 0) throw new HttpError("NOT_FOUND");
  return page(
    result.rows.map(
      (row): PublicMunicipality => ({
        id: row.id,
        name: row.name,
        timeZone: row.timezone,
        officialName: row.official_name,
        branding: {
          version: row.branding_version,
          logos: { light: row.light_logo, dark: row.dark_logo },
        },
      }),
    ),
  );
}
export async function accountNavigation(
  pool: Pool,
  actor: AuthenticatedAccount,
  after: string | null = null,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId: null },
    async (client) => {
      const municipalities = await client.query<MunicipalContext>(
        "SELECT * FROM domain.own_municipal_contexts($1)",
        [after],
      );
      const platform = await client.query<{
        operator: boolean;
        permissions: string[];
      }>("SELECT * FROM domain.own_platform_context()");
      return {
        municipalities: page(municipalities.rows),
        platform: platform.rows[0] ?? { operator: false, permissions: [] },
      };
    },
  );
}
