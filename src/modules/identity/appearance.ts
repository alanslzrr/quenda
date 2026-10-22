import type { Pool } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
export const palettes = ["neutral", "blue", "green"] as const;
export type Palette = (typeof palettes)[number];
export interface Appearance {
  version: number;
  lightPalette: Palette;
  darkPalette: Palette;
  defaultTheme: "light" | "dark";
}
export type AppearanceInput = Omit<Appearance, "version"> & {
  expectedVersion: number;
};
export async function publicAppearance(
  pool: Pool,
  tenantId: string,
): Promise<Appearance> {
  const row = (
    await pool.query<{
      version: number;
      light_palette: Palette;
      dark_palette: Palette;
      default_theme: "light" | "dark";
    }>("SELECT * FROM domain.public_municipal_appearance($1)", [tenantId])
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return {
    version: row.version,
    lightPalette: row.light_palette,
    darkPalette: row.dark_palette,
    defaultTheme: row.default_theme,
  };
}
export async function saveAppearance(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  input: AppearanceInput,
  correlationId: string,
): Promise<Appearance> {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= 2147483647 ||
    !palettes.includes(input.lightPalette) ||
    !palettes.includes(input.darkPalette) ||
    !["light", "dark"].includes(input.defaultTheme)
  )
    throw new HttpError("INVALID_INPUT");
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const row = (
        await client.query<{ version: number | null }>(
          "SELECT domain.save_municipal_appearance($1,$2,$3,$4,$5) AS version",
          [
            input.expectedVersion,
            input.lightPalette,
            input.darkPalette,
            input.defaultTheme,
            correlationId,
          ],
        )
      ).rows[0];
      if (!row?.version) throw new HttpError("CONFLICT");
      return {
        version: row.version,
        lightPalette: input.lightPalette,
        darkPalette: input.darkPalette,
        defaultTheme: input.defaultTheme,
      };
    },
  );
}
