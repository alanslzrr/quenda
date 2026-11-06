import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(
  new URL("../src/ui/foundation.css", import.meta.url),
  "utf8",
);
function block(selector: string) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, selector);
  return css.slice(start, css.indexOf("\n}", start));
}
const light = block(":root");
const dark = block(':root[data-theme="dark"]');

// Achromatic oklch has a relative luminance equal to the cube of its lightness.
function luminance(scope: string, token: string, seen = 0): number {
  assert.ok(seen < 5, `${token} does not resolve`);
  const own = new RegExp(`${token}:\\s*([^;]+);`).exec(scope)?.[1]?.trim();
  const value =
    own ?? new RegExp(`${token}:\\s*([^;]+);`).exec(light)?.[1]?.trim();
  assert.ok(value, `${token} is not defined`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference?.[1]) return luminance(scope, reference[1], seen + 1);
  const match = /^oklch\(([\d.]+)%\s+0\s+0\)$/.exec(value);
  assert.ok(match?.[1], `${token}: ${value} is not achromatic oklch`);
  return (Number(match[1]) / 100) ** 3;
}
function ratio(scope: string, a: string, b: string) {
  const [high, low] = [luminance(scope, a), luminance(scope, b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

for (const [name, scope, surfaces] of [
  ["light", light, ["--background", "--surface", "--surface-muted"]],
  [
    "dark",
    dark,
    ["--background", "--surface", "--surface-raised", "--surface-muted"],
  ],
] as const) {
  test(`${name} muted text reaches 4.5:1 on every surface (WCAG 1.4.3)`, () => {
    for (const surface of surfaces)
      assert.ok(
        ratio(scope, "--text-muted", surface) >= 4.5,
        `${surface}: ${ratio(scope, "--text-muted", surface).toFixed(2)}`,
      );
  });
  test(`${name} control borders reach 3:1 on every surface (WCAG 1.4.11)`, () => {
    for (const surface of surfaces)
      assert.ok(
        ratio(scope, "--border-strong", surface) >= 3,
        `${surface}: ${ratio(scope, "--border-strong", surface).toFixed(2)}`,
      );
  });
}
