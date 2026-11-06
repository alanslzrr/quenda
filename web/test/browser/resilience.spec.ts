import { expect, test } from "@playwright/test";

const accountId = "account-resilience";
const tenant = "00000000-0000-4000-8000-000000000001";
const session = {
  user: {
    id: accountId,
    name: "Ana",
    email: "ana@example.test",
    twoFactorEnabled: true,
  },
  session: {
    token: "synthetic",
    createdAt: "2026-10-01T12:00:00Z",
    expiresAt: "2030-01-01T12:00:00Z",
  },
};

async function mockAccount(
  page: import("@playwright/test").Page,
  options: { authSession?: () => unknown | Promise<unknown> } = {},
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: { accountId, email: "ana@example.test", mfaVerified: true },
      });
    if (path.endsWith("/preferences"))
      return route.fulfill({ json: { locale: "es" } });
    if (path.endsWith("/theme"))
      return route.fulfill({ json: { theme: "light" } });
    if (path.endsWith("/get-session"))
      return route.fulfill({
        json: (await options.authSession?.()) ?? session,
      });
    if (path.endsWith("/list-sessions")) return route.fulfill({ json: [] });
    if (path === "/api/me/navigation")
      return route.fulfill({
        json: {
          platform: { operator: false, permissions: [] },
          municipalities: { items: [], nextCursor: null },
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

test("blocked site storage does not stop the application from rendering", async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"])
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === "/api/me"
      ? route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
        })
      : route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Reservar" })).toBeVisible();
  await expect(page.getByText("Algo ha fallado")).toHaveCount(0);
});

test("a lazy chunk that no longer exists shows recovery instead of a blank page", async ({
  page,
}) => {
  await mockAccount(page);
  // Only reachable through React.lazy, unlike modules the layout imports statically.
  await page.route("**/features/catalog/facility*", (route) => route.abort());
  await page.goto(
    `/municipios/${tenant}/instalaciones/00000000-0000-4000-8000-000000000021`,
  );
  await expect(
    page
      .getByRole("heading", { name: /Hay una versión nueva|Algo ha fallado/ })
      .or(page.getByText(/Hay una versión nueva|Algo ha fallado/)),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Recargar" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Volver al inicio" }),
  ).toBeVisible();
});

test("a null get-session body leads back to sign-in instead of crashing", async ({
  page,
}) => {
  let accountReads = 0;
  await page.route("**/api/me", (route) => {
    accountReads += 1;
    return accountReads === 1
      ? route.fulfill({
          json: { accountId, email: "ana@example.test", mfaVerified: true },
        })
      : route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
        });
  });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await page.route("**/api/me/preferences", (route) =>
    route.fulfill({ json: { locale: "es" } }),
  );
  await page.route("**/api/me/theme", (route) =>
    route.fulfill({ json: { theme: "light" } }),
  );
  await page.goto("/perfil/seguridad");
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await expect(page.getByText("Algo ha fallado")).toHaveCount(0);
});

test("a malformed resource id never reaches the API", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHENTICATED", message: "Sin sesión" } },
    });
  });
  await page.goto("/municipios/not-a-uuid/unidades/..%2Fx");
  await expect(
    page.getByRole("heading", { name: "Página no encontrada" }),
  ).toBeVisible();
  expect(requests.filter((path) => path.includes("not-a-uuid"))).toHaveLength(
    0,
  );
  expect(
    requests.filter((path) => path.includes("public/municipalities")),
  ).toHaveLength(0);
});

test("an action-link token survives the account session resolving after the page mounted", async ({
  page,
}) => {
  await page.route("**/api/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      json: { accountId, email: "ana@example.test", mfaVerified: true },
    });
  });
  await page.route("**/api/me/preferences", (route) =>
    route.fulfill({ json: { locale: "es" } }),
  );
  await page.route("**/api/me/theme", (route) =>
    route.fulfill({ json: { theme: "light" } }),
  );
  await page.goto("/account/email-change/approve#synthetic-token");
  await expect(
    page.getByRole("button", { name: "Autorizar cambio", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(2000);
  await expect(
    page.getByRole("button", { name: "Autorizar cambio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Abre el enlace recibido por correo."),
  ).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
});

test("a failed background read keeps the personal-data draft and offers retry", async ({
  page,
}) => {
  let failing = false;
  await mockAccount(page, {
    authSession: () => {
      if (failing) throw new Error("unused");
      return session;
    },
  });
  await page.route("**/api/auth/get-session", (route) =>
    failing
      ? route.fulfill({
          status: 429,
          headers: { "retry-after": "1" },
          json: {
            error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes" },
          },
        })
      : route.fulfill({ json: session }),
  );
  await page.goto("/perfil/datos");
  const name = page.getByLabel("Nombre", { exact: true });
  await name.fill("Nombre a medias");
  failing = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
  );
  await expect(page.getByText("Demasiadas solicitudes")).toBeVisible();
  await expect(name).toHaveValue("Nombre a medias");
});

test("a review link without a space explains the problem instead of loading forever", async ({
  page,
}) => {
  await mockAccount(page);
  await page.goto(
    `/reservas/${tenant}/00000000-0000-4000-8000-0000000000aa/confirmar`,
  );
  await expect(
    page.getByText(
      "Este horario no es válido. Elige otro en la lista de horarios libres.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Elegir horario" }),
  ).toHaveAttribute("href", new RegExp(`/reservas/${tenant}/.+/modificar`));
});
