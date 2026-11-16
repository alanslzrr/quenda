import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000001";

async function mockPublic(page: Page, notices: Record<string, unknown> = {}) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        status: 401,
        json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
      });
    if (path === `/api/public/municipalities/${tenant}`)
      return route.fulfill({
        json: { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" },
      });
    if (path.endsWith("/appearance"))
      return route.fulfill({
        json: {
          version: 1,
          theme: "neutral",
          light: {},
          dark: {},
          font: "inter",
          corners: "round",
          defaultTheme: "light",
        },
      });
    const match = /\/notices\/(privacy|legal|accessibility)$/.exec(path);
    if (match?.[1])
      return route.fulfill({
        json: notices[path] ?? {
          kind: match[1],
          version: 0,
          body: {},
          publishedAt: null,
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}
const scan = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
  ).violations;

test("an instance without published texts still explains what the application does and what it stores", async ({
  page,
}) => {
  await mockPublic(page);
  await page.goto("/privacidad");
  await expect(
    page.getByRole("heading", {
      name: /Información sobre privacidad|Información sobre privacidade/,
    }),
  ).toBeVisible();
  // Without a published text the page shows the standard sections, never a placeholder,
  // and omits what only the entity can state.
  await expect(page.getByText(/Texto pendiente|Texto pendente/)).toHaveCount(0);
  for (const name of [
    /^(Finalidades)$/,
    /^(Base jurídica|Base xurídica)$/,
    /^(Ejercicio de derechos|Exercicio de dereitos)$/,
  ])
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByText(/www\.aepd\.es/)).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /^(Responsable del tratamiento|Responsable do tratamento)$/,
    }),
  ).toHaveCount(0);
  await expect(page.getByText("quenda.municipality")).toBeVisible();
  await expect(page.getByText("quenda.reservation-command")).toBeVisible();
  expect(await scan(page)).toEqual([]);

  // The footer lists the three legal pages only; the source offer lives in the legal notice.
  const footer = page.getByRole("navigation", { name: "Información legal" });
  await expect(footer.getByRole("link")).toHaveCount(3);
  await page.goto("/aviso-legal");
  await expect(
    page.getByRole("heading", {
      name: /^(Titular del sitio|Titular do sitio)$/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      name: /^(Descargar el código fuente|Descargar o código fonte)/,
    }),
  ).toHaveAttribute("href", "/legal/source");
  expect(await scan(page)).toEqual([]);
  await page.goto("/accesibilidad");
  await expect(
    page.getByText(/Real Decreto 1112\/2018|Real decreto 1112\/2018/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /^(Situación de cumplimiento|Situación de cumprimento)$/,
    }),
  ).toHaveCount(0);
  expect(await scan(page)).toEqual([]);
});

test("a municipality's published text appears in the active language with fallback and the footer links to it", async ({
  page,
}) => {
  await mockPublic(page, {
    [`/api/public/municipalities/${tenant}/notices/privacy`]: {
      kind: "privacy",
      version: 3,
      publishedAt: "2026-10-05T09:00:00Z",
      body: {
        gl: { controller: "Concello de Oleiros" },
        es: {
          controller: "Ayuntamiento de Oleiros",
          rights: "Escrito al registro municipal",
        },
      },
    },
    [`/api/public/municipalities/${tenant}/notices/accessibility`]: {
      kind: "accessibility",
      version: 1,
      publishedAt: "2026-10-05T09:00:00Z",
      body: {
        status: "partial",
        preparedOn: "2026-10-01",
        reviewedOn: "2026-10-04",
        es: { feedback: "accesibilidad@oleiros.example" },
      },
    },
  });
  await page.goto(`/municipios/${tenant}`);
  const footer = page.getByRole("navigation", { name: "Información legal" });
  await expect(
    footer.getByRole("link", { name: /^Privacidad|^Privacidade/ }),
  ).toHaveAttribute("href", `/municipios/${tenant}/privacidad`);
  await footer.getByRole("link", { name: /^Privacidad|^Privacidade/ }).click();
  await expect(
    page.getByText(/Ayuntamiento de Oleiros|Concello de Oleiros/),
  ).toBeVisible();
  // The Galician page has no "rights" text, so the Spanish one is shown instead of nothing.
  await expect(page.getByText("Escrito al registro municipal")).toBeVisible();
  await expect(page.getByText(/Texto pendiente|Texto pendente/)).toHaveCount(0);
  expect(await scan(page)).toEqual([]);

  await page.goto(`/municipios/${tenant}/accesibilidad`);
  await expect(
    page.getByText(/Parcialmente conforme con WCAG 2\.1 nivel AA/),
  ).toBeVisible();
  await expect(page.getByText("accesibilidad@oleiros.example")).toBeVisible();
  expect(await scan(page)).toEqual([]);

  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "Información legal" })
      .getByRole("link", { name: /^Accesibilidad|^Accesibilidade/ }),
  ).toHaveAttribute("href", "/accesibilidad");
});

test("creating an account links to the privacy information", async ({
  page,
}) => {
  await mockPublic(page);
  await page.goto("/registro");
  await page
    .getByRole("link", {
      name: /Cómo se tratan tus datos|Como se tratan os teus datos/,
    })
    .click();
  await expect(page).toHaveURL(/\/privacidad$/);
});

async function enter(page: Page, index: number) {
  const fixtures = JSON.parse(
    await readFile("test-results/municipal-fixtures.json", "utf8"),
  );
  const f = fixtures.find(
    (item: { email: string }) =>
      item.email === `municipal-${index}@example.test`,
  );
  await login(page, f.email, f.password);
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(totp(f.secret));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  return f;
}

test("an administrator publishes versions of the legal texts and the public page follows the latest", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const f = await enter(page, info.project.name === "desktop" ? 47 : 48);
  await page.goto(`/administracion/${f.tenant}/textos-legales`);
  const publish = page.getByRole("button", {
    name: "Publicar texto",
    exact: true,
  });
  const form = page.locator("form").filter({ has: publish });
  await form
    .getByLabel(/^(En castellano|En castelán)$/)
    .first()
    .fill("Ayuntamiento de prueba");
  await publish.click();
  await expect(page.getByText("Texto publicado.")).toBeVisible();
  await expect(page.getByText(/Versión publicada: 1/)).toBeVisible();
  // A second save from the same page uses the version it just created.
  await form
    .getByLabel(/^(En castellano|En castelán)$/)
    .first()
    .fill("Ayuntamiento de prueba, segunda versión");
  await publish.click();
  await expect(page.getByText(/Versión publicada: 2/)).toBeVisible();

  await page.goto(`/municipios/${f.tenant}/privacidad`);
  await expect(
    page.getByText("Ayuntamiento de prueba, segunda versión"),
  ).toBeVisible();
  await expect(page.getByText(/Texto pendiente|Texto pendente/)).toHaveCount(0);

  await page.goto(`/administracion/${f.tenant}/textos-legales`);
  await page
    .getByRole("tab", {
      name: /Declaración de accesibilidad|Declaración de accesibilidade/,
    })
    .click();
  const accessibility = page
    .locator("form")
    .filter({
      has: page.getByRole("button", { name: "Publicar texto", exact: true }),
    })
    .last();
  await accessibility
    .getByLabel(/Fecha de preparación|Data de preparación/)
    .fill("2026-10-01");
  await accessibility
    .getByLabel(/Fecha de la última revisión|Data da última revisión/)
    .fill("2026-09-01");
  await accessibility
    .getByRole("button", { name: "Publicar texto", exact: true })
    .click();
  // A review before preparation is rejected by the server and shown as an error, not published.
  await expect(page.getByRole("alert")).toBeVisible();
});
