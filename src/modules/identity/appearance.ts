import type { Pool, PoolClient } from "pg";
import { command } from "../../database/command.ts";
import { HttpError } from "../../http/errors.ts";
import { requireAdministrator } from "./administrator.ts";
import type { AuthenticatedAccount } from "./auth.ts";
import {
  type ColorOverrides,
  colorKeys,
  colorProblem,
  corners,
  fonts,
  hexColor,
  resolveColors,
  type ThemeId,
  themeBases,
  themes,
} from "./themes.ts";

export interface AppearanceSettings {
  theme: ThemeId;
  light: ColorOverrides;
  dark: ColorOverrides;
  font: (typeof fonts)[number];
  corners: (typeof corners)[number];
  defaultTheme: "light" | "dark";
}
export interface Appearance extends AppearanceSettings {
  version: number;
}
export type AppearanceInput = AppearanceSettings & { expectedVersion: number };

export const defaultAppearanceSettings: AppearanceSettings = {
  theme: "neutral",
  light: {},
  dark: {},
  font: "inter",
  corners: "round",
  defaultTheme: "light",
};

function overrides(value: unknown): value is ColorOverrides {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, color]) =>
        (colorKeys as readonly string[]).includes(key) &&
        typeof color === "string" &&
        hexColor.test(color),
    )
  );
}
/** Rejects anything outside the catalog and any combination that would not read well in either mode. */
export function validAppearance(value: AppearanceSettings) {
  return (
    (themes as readonly string[]).includes(value.theme) &&
    overrides(value.light) &&
    overrides(value.dark) &&
    (fonts as readonly string[]).includes(value.font) &&
    (corners as readonly string[]).includes(value.corners) &&
    ["light", "dark"].includes(value.defaultTheme) &&
    colorProblem("light", resolveColors(value.theme, "light", value.light)) ===
      null &&
    colorProblem("dark", resolveColors(value.theme, "dark", value.dark)) ===
      null
  );
}

interface Row {
  version: number;
  theme: string;
  light: ColorOverrides;
  dark: ColorOverrides;
  font: AppearanceSettings["font"];
  corners: AppearanceSettings["corners"];
  default_theme: "light" | "dark";
}
function fromRow(row: Row): Appearance {
  return {
    version: row.version,
    // A theme later retired from the catalog falls back to the neutral one rather than breaking the page.
    theme: (themes as readonly string[]).includes(row.theme)
      ? (row.theme as ThemeId)
      : "neutral",
    light: row.light,
    dark: row.dark,
    font: row.font,
    corners: row.corners,
    defaultTheme: row.default_theme,
  };
}
export async function publicAppearance(
  pool: Pool,
  tenantId: string,
): Promise<Appearance> {
  const row = (
    await pool.query<Row>(
      "SELECT * FROM domain.public_municipal_appearance($1)",
      [tenantId],
    )
  ).rows[0];
  if (!row) throw new HttpError("NOT_FOUND");
  return fromRow(row);
}

/** Writes the appearance inside an open administrator transaction; null when the version moved on. */
export async function writeAppearance(
  client: PoolClient,
  expectedVersion: number,
  value: AppearanceSettings,
  correlationId: string,
) {
  const row = (
    await client.query<{ version: number | null }>(
      "SELECT domain.save_municipal_appearance($1,$2,$3,$4,$5,$6,$7,$8) AS version",
      [
        expectedVersion,
        value.theme,
        JSON.stringify(value.light),
        JSON.stringify(value.dark),
        value.font,
        value.corners,
        value.defaultTheme,
        correlationId,
      ],
    )
  ).rows[0];
  return row?.version ?? null;
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
    !validAppearance(input)
  )
    throw new HttpError("INVALID_INPUT");
  const settings: AppearanceSettings = {
    theme: input.theme,
    light: input.light,
    dark: input.dark,
    font: input.font,
    corners: input.corners,
    defaultTheme: input.defaultTheme,
  };
  return command(
    pool,
    { accountId: actor.accountId, tenantId },
    async (client) => {
      await requireAdministrator(client, actor);
      const version = await writeAppearance(
        client,
        input.expectedVersion,
        settings,
        correlationId,
      );
      if (!version) throw new HttpError("STALE_VERSION");
      return { version, ...settings };
    },
  );
}

/**
 * The appearance of an exported catalog document, in either shape: the current one, or the two palettes written
 * before the theme catalog existed (the light palette becomes the theme; a different dark one is kept as dark
 * overrides, exactly as the migration did). Null when it is not a valid appearance.
 */
export function appearanceFromDocument(
  value: Record<string, unknown>,
): AppearanceSettings | null {
  let settings: AppearanceSettings;
  if ("lightPalette" in value) {
    const light = value.lightPalette;
    const dark = value.darkPalette;
    const legacy = ["neutral", "blue", "green"];
    if (
      typeof light !== "string" ||
      typeof dark !== "string" ||
      !legacy.includes(light) ||
      !legacy.includes(dark)
    )
      return null;
    settings = {
      ...defaultAppearanceSettings,
      theme: light as ThemeId,
      dark: light === dark ? {} : { ...themeBases[dark as ThemeId].dark },
      defaultTheme: value.defaultTheme as AppearanceSettings["defaultTheme"],
    };
  } else settings = value as unknown as AppearanceSettings;
  return validAppearance(settings) ? settings : null;
}
