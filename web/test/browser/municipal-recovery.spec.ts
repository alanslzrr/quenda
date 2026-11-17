import { expect, type Page } from "@playwright/test";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000091";
const root = `/api/municipalities/${tenant}`;
const base = `/administracion/${tenant}`;
const credential = "00000000-0000-4000-8000-000000000092";
const either = (es: string, gl: string) => new RegExp(`^(?:${es}|${gl})$`);
const retryName = either("Reintentar", "Tentar de novo");

test.use({ reducedMotion: "reduce" });

interface State {
  limited: boolean;
  navigationReads: number;
  agreements: unknown[];
  credentials: { revokedAt: string | null }[];
}
async function fixture(page: Page, initial: Partial<State> = {}) {
  const state: State = {
    limited: false,
    navigationReads: 0,
    agreements: [],
    credentials: [],
    ...initial,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "responsable",
        email: "admin@example.test",
        mfaVerified: true,
      };
    else if (path === "/api/me/preferences") body = { locale: null };
    else if (path === "/api/me/theme") body = { theme: "light" };
    else if (path === "/api/me/navigation") {
      state.navigationReads++;
      if (state.limited) {
        await route.fulfill({
          status: 429,
          headers: { "Retry-After": "3" },
          json: {
            error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes." },
          },
        });
        return;
      }
      body = {
        municipalities: {
          items: [
            {
              id: tenant,
              name: "Oleiros",
              administrator: true,
              permissions: [],
            },
          ],
          nextCursor: null,
        },
        platform: { operator: false, permissions: [] },
      };
    } else if (
      path === `${root}/agreements` ||
      path === `${root}/report-agreements`
    )
      body = { items: state.agreements, nextCursor: null };
    else if (path === `${root}/credentials`)
      body = {
        items: state.credentials.map((c) => ({
          id: credential,
          agreementName: "Rede deportiva",
          accountId: "persona",
          accountLabel: { name: "Persona", email: "persona@demo.test" },
          startsAt: "2026-10-01T00:00:00Z",
          endsAt: "2026-12-01T00:00:00Z",
          ...c,
        })),
        nextCursor: null,
      };
    await route.fulfill({ json: body });
  });
  return state;
}
async function openMenu(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page
      .getByRole("button", {
        name: either("Gestión municipal", "Xestión municipal"),
      })
      .click();
}

test("a rate-limited municipal page keeps the management shell, waits, then recovers on request", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  const state = await fixture(page, { limited: true });
  await page.goto(`${base}/informes`);
  const retry = page.getByRole("button", { name: retryName });
  await expect(retry).toBeDisabled();
  await expect(page.getByRole("timer")).toContainText("3 s.");
  // No permission was read, so only personal entries and the way out remain.
  await openMenu(page);
  await expect(
    page.getByRole("link", {
      name: either("Mis reservas", "As miñas reservas"),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Convenios", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Cambiar municipio/ }),
  ).toHaveAttribute("href", "/administracion");
  expect(await accessibilityViolations(page, { allRules: true })).toEqual([]);
  if ((page.viewportSize()?.width ?? 1280) < 768)
    await page.keyboard.press("Escape");
  const baseline = state.navigationReads;
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:03.500Z"));
  await expect(retry).toBeEnabled();
  expect(state.navigationReads).toBe(baseline);
  state.limited = false;
  await retry.click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: either("Informe conjunto mensual", "Informe conxunto mensual"),
    }),
  ).toBeVisible();
  await expect(retry).toHaveCount(0);
  await openMenu(page);
  await expect(
    page.getByRole("link", { name: "Convenios", exact: true }),
  ).toBeVisible();
});

test("a rate-limited municipal page reuses the permissions already read in the session", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  const state = await fixture(page);
  await page.goto("/administracion");
  await expect(page.getByRole("link", { name: /Oleiros/ })).toBeVisible();
  state.limited = true;
  await page.getByRole("link", { name: /Oleiros/ }).click();
  await expect(page.getByRole("button", { name: retryName })).toBeDisabled();
  await openMenu(page);
  await expect(
    page.getByRole("link", { name: "Convenios", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Oleiros/ }).first(),
  ).toBeVisible();
});

test("report and review queries explain why they are unavailable without agreements", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`${base}/informes`);
  const report = page.getByRole("button", { name: "Consultar informe" });
  await expect(report).toBeDisabled();
  await expect(report).toHaveAccessibleDescription(
    /pertenecen a un convenio|pertencen a un convenio/,
  );
  expect(await accessibilityViolations(page, { allRules: true })).toEqual([]);
  await page.goto(`${base}/informes/revision`);
  const review = page.getByRole("button", {
    name: "Consultar contexto de revisión",
  });
  await expect(review).toBeDisabled();
  await expect(review).toHaveAccessibleDescription(
    /Solo se revisan|Só se revisan/,
  );
});

test("report query stays available when the municipality has agreements", async ({
  page,
}) => {
  await fixture(page, {
    agreements: [
      {
        agreementId: "00000000-0000-4000-8000-000000000093",
        name: "Rede deportiva",
      },
    ],
  });
  await page.goto(`${base}/informes`);
  await expect(
    page.getByRole("button", { name: "Consultar informe" }),
  ).toBeEnabled();
});

test("revocation is unavailable with nothing to revoke, unless a known reference is given", async ({
  page,
}) => {
  const state = await fixture(page);
  const revoke = page.getByRole("button", {
    name: either("Revocar acreditación", "Revogar acreditación"),
  });
  await page.goto(`${base}/acreditaciones`);
  await expect(revoke).toBeDisabled();
  await expect(revoke).toHaveAccessibleDescription(/Aún no hay|Aínda non hai/);
  expect(await accessibilityViolations(page, { allRules: true })).toEqual([]);
  await page
    .getByRole("button", {
      name: either(
        "Usar una referencia conocida",
        "Usar unha referencia coñecida",
      ),
    })
    .click();
  await page
    .getByLabel(
      either("Identificador de acreditación", "Identificador de acreditación"),
    )
    .fill(credential);
  await expect(revoke).toBeEnabled();

  state.credentials = [{ revokedAt: "2026-10-20T00:00:00Z" }];
  await page.reload();
  await expect(revoke).toBeDisabled();
  await expect(revoke).toHaveAccessibleDescription(
    /ya están revocadas|xa están revogadas/,
  );

  state.credentials = [{ revokedAt: null }];
  await page.reload();
  await expect(revoke).toBeEnabled();
});
