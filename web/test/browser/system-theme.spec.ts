import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

async function choose(page: Page, name: RegExp) {
  await page.getByRole("button", { name: /^(Ajustes|Axustes)$/ }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("visitor can follow the OS, pin a theme and return to the municipal default", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await choose(page, /^Sistema$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
    "content",
    "dark",
  );
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await choose(page, /^Modo claro$/);
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // A second tab updates the visitor preference through the same settings UI.
  const other = await context.newPage();
  await other.goto("/");
  await choose(other, /^Sistema$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.close();
  await choose(page, /^Tema (del|do) municipio$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("quenda.preferences") ?? "{}").theme,
    ),
  ).toBeNull();
});

test("stored system preference is applied before the application bundle loads", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "quenda.preferences",
      JSON.stringify({ locale: "es", theme: "system" }),
    ),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/src/main.tsx*", (route) => route.abort());
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
    "content",
    "dark",
  );
});
