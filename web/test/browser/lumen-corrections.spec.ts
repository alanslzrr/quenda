import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000091";
const base = `/administracion/${tenant}`;
async function fixture(page: Page, theme: "light" | "dark" = "dark") {
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "admin",
        email: "admin@demo.test",
        mfaVerified: true,
      };
    if (path === "/api/me/preferences") body = { locale: "es" };
    if (path === "/api/me/theme") body = { theme };
    if (path === "/api/me/navigation")
      body = {
        municipalities: {
          items: [
            {
              id: tenant,
              name: "Valdeira",
              administrator: true,
              permissions: [],
            },
          ],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    if (path.endsWith("/appearance"))
      body = {
        version: 1,
        lightPalette: "neutral",
        darkPalette: "neutral",
        defaultTheme: "light",
      };
    if (path === `/api/municipalities/${tenant}/facilities`)
      body = {
        items: [
          { id: tenant, name: "Polideportivo municipal", published: true },
        ],
        nextCursor: null,
      };
    await route.fulfill({ json: body });
  });
  return writes;
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("Lumen action links stay flat and menu links never acquire browser underlines", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto(base);
  const link = page.getByRole("link", {
    name: "Polideportivo municipal",
    exact: true,
  });
  await expect(link).toBeVisible();
  for (const property of ["border-top-width", "border-radius"])
    await expect(link).toHaveCSS(property, "0px");
  await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(link).toHaveCSS("box-shadow", "none");
  await expect(link).toHaveCSS("text-decoration-line", "none");
  await expect(link.locator("svg")).toHaveCount(0);
  await link.focus();
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS("outline-style", "solid");
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  for (const name of ["Mi cuenta", "Mis reservas", "Avisos"]) {
    const item = page.getByRole("menuitem", { name, exact: true });
    await expect(item).toHaveCSS("text-decoration-line", "none");
    await expect(item.locator("svg")).toHaveCount(0);
    await expect(item).toHaveAttribute("href", /\//);
  }
  await page.getByRole("menuitem", { name: "Mi cuenta", exact: true }).focus();
  await expect(
    page.getByRole("menuitem", { name: "Mi cuenta", exact: true }),
  ).toHaveCSS("text-decoration-line", "none");
  await page.screenshot({
    path: `test-results/lumen-menu-${info.project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Ajustes", exact: true }),
  ).toBeFocused();
});

test("known references use a text-only keyboard disclosure without a native triangle", async ({
  page,
}, info) => {
  const writes = await fixture(page);
  await page.goto(`${base}/acreditaciones`);
  const toggle = page.getByRole("button", {
    name: "Usar una referencia conocida",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("type", "button");
  await expect(page.locator("details, summary")).toHaveCount(0);
  await expect(toggle.locator("svg")).toHaveCount(0);
  await expect(toggle).toHaveCSS("border-top-width", "0px");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Identificador de acreditación", { exact: true }),
  ).toBeVisible();
  const expanded = page.getByRole("button", {
    name: /Usar una referencia conocida.*Ocultar/,
  });
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
  await expect(expanded).toBeFocused();
  await page.screenshot({
    path: `test-results/lumen-reference-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByLabel("Identificador de acreditación", { exact: true })
    .pressSequentially("00000000-0000-4000-8000-000000000091");
  await expect(
    page.getByLabel("Identificador de acreditación", { exact: true }),
  ).toHaveValue("00000000-0000-4000-8000-000000000091");
  await page
    .getByLabel("Motivo", { exact: true })
    .fill("Solo validar navegación, sin revocar");
  await page
    .getByRole("checkbox", { name: "Confirmo la revocación", exact: true })
    .check();
  await page
    .getByLabel("Identificador de acreditación", { exact: true })
    .fill("00000000-0000-4000-8000-000000000092");
  await expect(
    page.getByRole("checkbox", { name: "Confirmo la revocación", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Confirmo la revocación", exact: true })
    .check();
  await expanded.click();
  await expect(
    page.getByLabel("Identificador de acreditación", { exact: true }),
  ).toBeHidden();
  expect(writes).toEqual([]);
});

for (const personal of ["light", "dark"] as const) {
  test(`appearance previews the whole application over personal ${personal} and restores it without saving`, async ({
    page,
  }, info) => {
    const writes = await fixture(page, personal);
    await page.goto(`${base}/apariencia`);
    await expect(
      page.getByRole("combobox", { name: "Modo de vista previa", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", personal);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme-preview",
    );
    const preview = personal === "dark" ? "light" : "dark";
    const modeLabel = preview === "light" ? "Claro" : "Oscuro";
    const paletteLabel = preview === "light" ? "Paleta clara" : "Paleta oscura";
    await select(page, paletteLabel, "Azul");
    await select(page, "Modo de vista previa", modeLabel);
    await expect(page.locator("html")).toHaveAttribute("data-theme", preview);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preview",
      "true",
    );
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      preview === "light" ? "rgb(249, 251, 255)" : "rgb(20, 29, 43)",
    );
    await expect(
      page.getByRole("region", { name: "Vista previa pública" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Ajustes", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCSS(
      "color",
      preview === "light" ? "rgb(23, 38, 56)" : "rgb(241, 245, 252)",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ajustes", exact: true }),
    ).toBeFocused();
    await expect(page.locator('a[href="#content"]')).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/lumen-preview-${personal}-${info.project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Salir de la vista previa", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Modo de vista previa", exact: true }),
    ).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", personal);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme-preview",
    );
    await expect(
      page.getByRole("combobox", { name: paletteLabel, exact: true }),
    ).toContainText("Azul");
    await select(page, "Modo de vista previa", modeLabel);
    await page
      .getByRole("button", {
        name: "Descartar borrador y recargar",
        exact: true,
      })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", personal);
    await expect(
      page.getByRole("combobox", { name: paletteLabel, exact: true }),
    ).toContainText("Neutro");
    await select(page, paletteLabel, "Azul");
    await page
      .getByRole("button", {
        name: "Restaurar valores predeterminados",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("combobox", { name: paletteLabel, exact: true }),
    ).toContainText("Neutro");
    expect(writes).toEqual([]);
    await select(page, "Modo de vista previa", modeLabel);
    // SPA navigation proves unmount cleanup; a full reload would mask a leaked preview.
    await page.getByRole("button", { name: "Ajustes", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Mis reservas", exact: true })
      .click();
    await expect(page).toHaveURL("/reservas");
    await expect(page.locator("html")).toHaveAttribute("data-theme", personal);
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme-preview",
    );
    expect(writes).toEqual([]);
  });
}

test("audit regression: pagination cannot submit a valid revocation", async ({
  page,
}) => {
  const writes = await fixture(page);

  await page.route(
    `**/api/municipalities/${tenant}/credentials**`,
    async (route) => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().url());
        await route.fulfill({ json: { id: tenant } });
        return;
      }

      await route.fulfill({
        json: {
          items: [],
          nextCursor: new URL(route.request().url()).searchParams.has("after")
            ? null
            : tenant,
        },
      });
    },
  );
  await page.route("**/api/public/reservation-command-policy", (route) =>
    route.fulfill({
      json: { retentionSeconds: 86400, serverTime: new Date().toISOString() },
    }),
  );
  await page.goto(`${base}/acreditaciones?referencia=${tenant}`);
  for (const input of ["pointer", "keyboard"]) {
    if (input === "keyboard") await page.reload();
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Corrección autorizada");
    await page
      .getByRole("checkbox", { name: "Confirmo la revocación" })
      .check();
    const more = page.getByRole("button", { name: "Cargar más", exact: true });
    await expect(more).toHaveAttribute("type", "button");
    if (input === "pointer") await more.click();
    else {
      await more.focus();
      await page.keyboard.press("Enter");
    }
    await expect(more).toHaveCount(0);
    expect(writes).toHaveLength(0);
  }
  await page
    .getByRole("button", { name: "Revocar acreditación", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Revocación registrada");
  expect(writes).toHaveLength(1);
});
