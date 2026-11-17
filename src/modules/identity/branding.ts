import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import { processLogo } from "./logo-image.ts";

export const logoVariants = ["light", "dark"] as const;
export type LogoVariant = (typeof logoVariants)[number];
export interface Branding {
  version: number;
  /** The name shown everywhere, chosen by the municipal administration. */
  name: string;
  /** The name the platform operator registered the municipality with. */
  officialName: string;
  logos: { light: boolean; dark: boolean };
}

export async function publicBranding(
  pool: Pool | PoolClient,
  tenantId: string,
): Promise<Branding> {
  const row = (
    await pool.query<{
      version: number;
      name: string;
      official_name: string;
      light_logo: boolean;
      dark_logo: boolean;
    }>("SELECT * FROM domain.public_municipal_branding($1)", [tenantId])
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    version: row.version,
    name: row.name,
    officialName: row.official_name,
    logos: { light: row.light_logo, dark: row.dark_logo },
  };
}

export async function publicLogo(
  pool: Pool,
  tenantId: string,
  variant: LogoVariant,
) {
  const row = (
    await pool.query<{ version: number; image: Buffer }>(
      "SELECT * FROM domain.public_municipal_logo($1,$2)",
      [tenantId, variant],
    )
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return row;
}

const validVersion = (value: number) =>
  Number.isInteger(value) && value >= 1 && value < 2147483647;

/** Runs one branding change as the municipality's administrator; a moved version is stale. */
async function change(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  write: (client: PoolClient) => Promise<number | null>,
) {
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const version = await write(client);
      if (!version) throw new HttpError("STALE_VERSION");
      return publicBranding(client, tenantId);
    },
  );
}

/** Spaces are tidied the way a person would expect; control characters and empty names are refused. */
export function normalizeMunicipalName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Control characters are exactly what must be refused.
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    return null;
  return name;
}

export async function renameMunicipality(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: { expectedVersion: number; name: string },
  correlationId: string,
) {
  const name = normalizeMunicipalName(input.name);
  if (!validVersion(input.expectedVersion) || !name)
    throw new HttpError("INVALID_INPUT");
  return change(pool, actor, tenantId, async (client) => {
    const row = (
      await client.query<{ version: number | null }>(
        "SELECT domain.rename_municipality($1,$2,$3) AS version",
        [input.expectedVersion, name, correlationId],
      )
    ).rows[0];
    return row?.version ?? null;
  });
}

export async function saveLogo(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  variant: LogoVariant,
  input: { expectedVersion: number; image: string },
  correlationId: string,
) {
  if (
    !validVersion(input.expectedVersion) ||
    !logoVariants.includes(variant) ||
    typeof input.image !== "string"
  )
    throw new HttpError("INVALID_INPUT");
  const logo = await processLogo(Buffer.from(input.image, "base64"));
  return change(pool, actor, tenantId, async (client) => {
    try {
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.save_municipal_logo($1,$2,$3,$4,$5,$6) AS version",
          [
            input.expectedVersion,
            variant,
            logo.image,
            logo.width,
            logo.height,
            correlationId,
          ],
        )
      ).rows[0];
      return row?.version ?? null;
    } catch (error) {
      // A dark variant without a main logo.
      if ((error as { code?: string }).code === "22023")
        throw new HttpError("INVALID_INPUT");
      throw error;
    }
  });
}

export async function removeLogo(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  variant: LogoVariant,
  expectedVersion: number,
  correlationId: string,
) {
  if (!validVersion(expectedVersion) || !logoVariants.includes(variant))
    throw new HttpError("INVALID_INPUT");
  return change(pool, actor, tenantId, async (client) => {
    try {
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.remove_municipal_logo($1,$2,$3) AS version",
          [expectedVersion, variant, correlationId],
        )
      ).rows[0];
      return row?.version ?? null;
    } catch (error) {
      if ((error as { code?: string }).code === "P0002")
        throw new HttpError("NOT_FOUND");
      throw error;
    }
  });
}
