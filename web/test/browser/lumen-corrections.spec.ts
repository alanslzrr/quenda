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
        theme: "neutral",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
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

test("record links stay flat with a chevron and menu links never acquire browser underlines", async ({
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
  // A decorative chevron, not an underline, marks the name as something that opens.
  await expect(link.locator('svg[aria-hidden="true"]')).toHaveCount(1);
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

test("known references use a keyboard disclosure with a chevron instead of a native triangle", async ({
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
  await expect(toggle.locator('svg[aria-hidden="true"]')).toHaveCount(1);
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
    const modeLabel = (mode: "light" | "dark") =>
      mode === "light" ? "Claro" : "Oscuro";
    // "Modo inicial" is a radio group with the same two names, so the previewed mode is picked within its own group.
    const viewing = page.getByRole("group", {
      name: "Modo que estás viendo",
    });
    // The editor opens in the person's own mode and already shows the municipal draft.
    await expect(
      viewing.getByRole("radio", { name: modeLabel(personal), exact: true }),
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", personal);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preview",
      "true",
    );
    const preview = personal === "dark" ? "light" : "dark";
    await viewing
      .getByRole("radio", { name: modeLabel(preview), exact: true })
      .check();
    await page.getByRole("button", { name: "Neutro", exact: true }).click();
    await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", preview);
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      preview === "light" ? "rgb(249, 251, 255)" : "rgb(20, 29, 43)",
    );
    await expect(page.getByText("Cambios sin guardar")).toBeVisible();
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
    // Discarding returns to the saved appearance without a request.
    await page.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-accent",
      "neutral",
    );
    await expect(page.getByText("Cambios sin guardar")).toHaveCount(0);
    await page.getByRole("button", { name: "Neutro", exact: true }).click();
    await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Restaurar valores predeterminados",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Neutro", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Cambios sin guardar")).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "Neutro", exact: true }).click();
    await page.getByRole("menuitem", { name: "Azul", exact: true }).click();
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
    // Coming back recovers the unsaved draft of this tab.
    await page.goBack();
    await expect(page.getByText("Cambios sin guardar")).toBeVisible();
    await expect(
      page.getByText("Recuperamos los cambios que no llegaste a guardar."),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
    expect(writes).toEqual([]);
  });
}

test("municipal management wears the municipality's saved theme, typeface and corners", async ({
  page,
}) => {
  await fixture(page, "light");
  await page.route(
    `**/api/public/municipalities/${tenant}/appearance`,
    (route) =>
      route.fulfill({
        json: {
          version: 4,
          theme: "vineyard",
          light: { accent: "#6d1a3a" },
          dark: {},
          font: "serif",
          corners: "square",
          defaultTheme: "light",
        },
      }),
  );
  await page.goto(`${base}/agenda`);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "vineyard");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(252, 247, 248)",
  );
  const root = (name: string) =>
    page
      .locator("html")
      .evaluate((el, n) => el.style.getPropertyValue(n), name);
  expect(await root("--accent")).toBe("#6d1a3a");
  expect(await root("--radius-control")).toBe("0.25rem");
  expect(await root("--font-body")).toMatch(/serif$/);
  // Leaving the municipality returns to the instance theme.
  await page.goto("/reservas");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "neutral");
});

test("municipal identity uploads a raster logo, refuses SVG before sending and renames the municipality", async ({
  page,
}) => {
  // Branding writes go to their own routes below; nothing else may be written.
  const writes = await fixture(page, "light");
  const logo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAvUlEQVR4nOXOIQEAIBAAsWvwPRH0d3yMCcT8mnvez9IBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gEtHdDSAS0d0NIBLR3Q0gFtAQ9BYcMzBICoAAAAAElFTkSuQmCC",
    "base64",
  );
  let state = {
    version: 1,
    name: "Valdeira",
    officialName: "Concello de Valdeira",
    logos: { light: false, dark: false },
  };
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  // Branding travels with the public municipality record.
  await page.route(`**/api/public/municipalities/${tenant}`, (route) =>
    route.fulfill({
      json: {
        id: tenant,
        name: state.name,
        timeZone: "Europe/Madrid",
        officialName: state.officialName,
        branding: { version: state.version, logos: state.logos },
      },
    }),
  );
  await page.route(`**/api/public/municipalities/${tenant}/logo/**`, (route) =>
    route.fulfill({ body: logo, contentType: "image/png" }),
  );
  await page.route(`**/api/municipalities/${tenant}/branding/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push({ path, body });
    state = path.endsWith("/name")
      ? { ...state, version: state.version + 1, name: String(body.name) }
      : {
          ...state,
          version: state.version + 1,
          logos: { ...state.logos, light: true },
        };
    return route.fulfill({ json: state });
  });
  await page.goto(`${base}/apariencia`);
  await expect(
    page.getByText(/Nombre oficial de alta: Concello de Valdeira/),
  ).toBeVisible();
  // A vector file never leaves the browser.
  await page.getByLabel("Logo", { exact: true }).setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(page.getByText(/No se admiten SVG/)).toBeVisible();
  expect(sent).toEqual([]);
  await page.getByLabel("Logo", { exact: true }).setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: logo,
  });
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({
    path: `/api/municipalities/${tenant}/branding/logos/light`,
    body: { expectedVersion: 1, image: logo.toString("base64") },
  });
  // The menu shows the logo instead of the product mark, and the dark version becomes available.
  await expect(
    page.locator(`img[src*="/logo/light?v=2"]`).first(),
  ).toBeAttached();
  await expect(page.getByText("Logo para fondo oscuro")).toBeVisible();
  await page.getByLabel("Nombre visible").fill("  Concello de Valdeira ");
  await page.getByRole("button", { name: "Guardar nombre" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.body).toEqual({
    expectedVersion: 2,
    name: "  Concello de Valdeira ",
  });
  expect(writes).toEqual([]);
});

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
