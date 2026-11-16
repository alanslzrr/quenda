import assert from "node:assert/strict";
import test from "node:test";
import { themeBases } from "../../src/modules/identity/themes.ts";
import {
  colorProblem,
  contrast,
  defaultAppearance,
  deriveTokens,
  resolveColors,
  themeVariables,
} from "../src/app/theme.ts";
import { themeCatalog, themeIds } from "../src/app/themes.ts";

test("the web catalog holds exactly the server's themes and base colours", () => {
  assert.deepEqual(themeIds, Object.keys(themeBases));
  for (const id of themeIds)
    for (const mode of ["light", "dark"] as const)
      assert.deepEqual(
        themeCatalog[id][mode],
        themeBases[id as keyof typeof themeBases][mode],
        `${id}/${mode}`,
      );
});

const surfaces = (tokens: ReturnType<typeof deriveTokens>) => [
  tokens["--background"],
  tokens["--surface-raised"],
  tokens["--surface-muted"],
];
function readable(label: string, tokens: ReturnType<typeof deriveTokens>) {
  for (const surface of surfaces(tokens)) {
    for (const text of [
      "--foreground",
      "--text-secondary",
      "--text-muted",
      "--accent-strong",
    ] as const)
      assert.ok(
        contrast(tokens[text], surface) >= 4.5,
        `${label} ${text} on ${surface}: ${contrast(tokens[text], surface).toFixed(2)}`,
      );
    assert.ok(
      contrast(tokens["--border-strong"], surface) >= 3,
      `${label} control border`,
    );
  }
  // The accent has 3:1 on the background; its text is whichever of background or foreground stands out more.
  assert.ok(
    contrast(tokens["--accent-foreground"], tokens["--accent"]) >= 3,
    `${label} button text`,
  );
}

test("every theme passes the contrast rule and derives readable text, borders and buttons in both modes", () => {
  for (const id of themeIds)
    for (const mode of ["light", "dark"] as const) {
      const colors = themeCatalog[id][mode];
      assert.equal(colorProblem(mode, colors), null, `${id}/${mode}`);
      readable(`${id}/${mode}`, deriveTokens(mode, colors));
      assert.ok(
        contrast(
          deriveTokens(mode, colors)["--accent-foreground"],
          colors.accent,
        ) >= 4.5,
        `${id}/${mode} button text`,
      );
    }
});

test("any combination the server accepts still derives readable secondary text, borders and buttons", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const color = () =>
    `#${Math.floor(random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  let checked = 0;
  for (let n = 0; n < 20000 && checked < 400; n++) {
    const mode = n % 2 ? "dark" : "light";
    const colors = {
      background: color(),
      foreground: color(),
      accent: color(),
    };
    if (colorProblem(mode, colors)) continue;
    readable(`${mode} ${JSON.stringify(colors)}`, deriveTokens(mode, colors));
    checked++;
  }
  assert.ok(checked >= 100, `only ${checked} valid combinations sampled`);
});

test("valid overrides replace the theme colours; unreadable ones fall back to the theme", () => {
  const custom = {
    ...defaultAppearance,
    theme: "blue" as const,
    light: { accent: "#7a1f9c" },
    dark: { background: "#101010" },
  };
  assert.deepEqual(resolveColors("light", custom), {
    ...themeCatalog.blue.light,
    accent: "#7a1f9c",
  });
  assert.equal(resolveColors("dark", custom).background, "#101010");
  // Pale accent on a light background: the whole mode returns to the theme.
  assert.deepEqual(
    resolveColors("light", { ...custom, light: { accent: "#eeeeee" } }),
    themeCatalog.blue.light,
  );
  // Malformed colours are ignored.
  assert.deepEqual(
    resolveColors("light", { ...custom, light: { accent: "red" } }),
    themeCatalog.blue.light,
  );
  assert.equal(
    colorProblem("light", {
      ...themeCatalog.neutral.light,
      foreground: "#cccccc",
    }),
    "TEXT_CONTRAST",
  );
  assert.equal(
    colorProblem("light", {
      ...themeCatalog.neutral.light,
      background: "#222222",
    }),
    "LIGHT_BACKGROUND",
  );
  assert.equal(
    colorProblem("dark", {
      ...themeCatalog.neutral.dark,
      background: "#eeeeee",
    }),
    "DARK_BACKGROUND",
  );
  assert.equal(
    colorProblem("dark", { ...themeCatalog.neutral.dark, accent: "#333333" }),
    "ACCENT_CONTRAST",
  );
});

test("an unknown theme, typeface or corner shape from the server falls back instead of throwing", () => {
  const neutral = themeVariables("light", defaultAppearance);
  assert.deepEqual(
    themeVariables("light", {
      ...defaultAppearance,
      theme: "magenta" as never,
      font: "comic" as never,
      corners: "__proto__" as never,
    }),
    neutral,
  );
  assert.doesNotThrow(() => themeVariables("light", {} as never));
  assert.doesNotThrow(() => themeVariables("dark", null));
  const square = themeVariables("dark", {
    ...defaultAppearance,
    font: "serif",
    corners: "square",
  });
  assert.equal(square["--radius-control"], "0.25rem");
  assert.match(square["--font-body"] ?? "", /serif$/);
});
