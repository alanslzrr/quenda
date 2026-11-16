import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000002",
  id = "00000000-0000-4000-8000-000000000003",
  other = "00000000-0000-4000-8000-000000000004";
const startsAt = new Date(Date.now() + 3 * 86400000).toISOString(),
  endsAt = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
const reservation = {
  id,
  tenantId: tenant,
  accountId: "ana",
  unitId: unit,
  startsAt,
  endsAt,
  status: "CONFIRMADA",
  revision: 1,
  timeZone: "Europe/Madrid",
  cancellationMinutes: 1440,
  usageRulesUnitId: unit,
  usageRulesVersion: 1,
  rulesAcceptedAt: new Date().toISOString(),
  usageRulesText: "Normas originales",
  pendingUsageRulesVersion: null,
  pendingUsageRulesText: null,
  bookingPolicyVersion: 1,
};
const detail = `/reservas/${tenant}/${id}`,
  path = `/api/municipalities/${tenant}/reservations`,
  checkout = `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent(startsAt)}&fin=${encodeURIComponent(endsAt)}`;
test.beforeEach(async ({ page }, info) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname === "/api/me")
      body = {
        accountId: "ana",
        email: "ana@example.test",
        mfaVerified: false,
      };
    else if (url.pathname.endsWith("/preferences")) body = { locale: "es" };
    else if (url.pathname.endsWith("/theme"))
      body = { theme: info.project.name === "desktop" ? "light" : "dark" };
    else if (url.pathname.endsWith("/appearance"))
      body = {
        version: 1,
        theme: "green",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
        defaultTheme: "light",
      };
    else if (url.pathname.endsWith("/reservation-command-policy"))
      body = { retentionSeconds: 3600, serverTime: new Date().toISOString() };
    else if (url.pathname.endsWith(`/units/${unit}`))
      body = {
        id: unit,
        name: "Pista 1",
        timeZone: "Europe/Madrid",
        cancellationMinutes: 1440,
        usageRulesVersion: 1,
        bookingPolicyVersion: 1,
      };
    else if (url.pathname.endsWith("/usage-rules"))
      body = { version: 1, text: "Normas originales" };
    else if (url.pathname === `${path}/${id}`) body = reservation;
    else if (url.pathname === "/api/public/municipalities")
      body = {
        items: [
          { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" },
          { id: other, name: "A Coruña", timeZone: "Europe/Madrid" },
        ],
        nextCursor: null,
      };
    else if (url.pathname === "/api/me/reservations/municipalities")
      body = {
        items: [
          { tenantId: tenant, name: "Oleiros" },
          { tenantId: other, name: "A Coruña" },
        ],
        nextCursor: null,
      };
    else if (url.pathname === "/api/me/reservations")
      body = {
        items: [
          { ...reservation, municipality: "Oleiros", unitName: "Pista 1" },
        ],
        nextCursor: null,
      };
    await route.fulfill({ json: body });
  });
});
test("changed conditions clear acceptance and require explicit review without confirming", async ({
  page,
}) => {
  let version = 1,
    posts = 0;
  await page.route(
    `**/api/public/municipalities/${tenant}/units/${unit}`,
    (r) =>
      r.fulfill({
        json: {
          id: unit,
          name: "Pista 1",
          timeZone: "Europe/Madrid",
          cancellationMinutes: 1440,
          usageRulesVersion: version,
          bookingPolicyVersion: 1,
        },
      }),
  );
  await page.route("**/usage-rules", (r) =>
    r.fulfill({ json: { version, text: `Normas vigentes ${version}` } }),
  );
  await page.route(`**${path}`, async (r) => {
    posts++;
    version = 2;
    await r.fulfill({
      status: 409,
      json: {
        error: {
          code: "CONDITIONS_CHANGED",
          message: "Las condiciones han cambiado. Revisa las nuevas normas.",
        },
      },
    });
  });
  await page.goto(checkout);
  await page
    .getByRole("checkbox", { name: /He leído y acepto las normas de uso/ })
    .check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(
    page.getByText("Las condiciones han cambiado. Revisa las nuevas normas."),
  ).toBeVisible();
  await expect(page.getByText("Normas vigentes 2")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /He leído y acepto las normas de uso/ }),
  ).not.toBeChecked();
  expect(posts).toBe(1);
  await expect(page).toHaveURL(/\/reservar\?/);
});
test("lost response survives reload and explicit replay retains its payload and key", async ({
  page,
}) => {
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route(`**${path}`, async (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"],
      body: r.request().postData(),
    });
    if (requests.length === 1) await r.abort("failed");
    else await r.fulfill({ json: reservation });
  });
  await page.goto(checkout);
  await page
    .getByRole("checkbox", { name: /He leído y acepto las normas de uso/ })
    .check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await page.getByRole("link", { name: /Hay una operación/ }).click();
  await page.reload();
  expect(requests).toHaveLength(1);
  await page
    .getByRole("button", { name: "Comprobar con la misma solicitud" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${detail}$`));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.reservation-command"),
    ),
  ).toBeNull();
});
test("pending rules can be accepted near start without changing historical evidence or cancellation", async ({
  page,
}) => {
  const soon = {
    ...reservation,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 7200000).toISOString(),
    rulesAcceptedAt: null,
    usageRulesVersion: null,
    usageRulesUnitId: null,
    usageRulesText: null,
    pendingUsageRulesVersion: 7,
    pendingUsageRulesText: "Normas de la nueva pista",
  };
  let accepted = false;
  await page.route(`**${path}/${id}`, (r) =>
    r.fulfill({
      json: accepted
        ? {
            ...soon,
            revision: 2,
            rulesAcceptedAt: new Date().toISOString(),
            usageRulesUnitId: unit,
            usageRulesVersion: 7,
            usageRulesText: soon.pendingUsageRulesText,
            pendingUsageRulesVersion: null,
            pendingUsageRulesText: null,
          }
        : soon,
    }),
  );
  await page.route(`**${path}/${id}/accept-usage-rules`, async (r) => {
    expect(r.request().postDataJSON()).toEqual({
      expectedRevision: 1,
      unitId: unit,
      usageRulesVersion: 7,
    });
    accepted = true;
    await r.fulfill({ json: { ...soon, revision: 2 } });
  });
  await page.goto(detail);
  await expect(
    page.getByText(
      "No consta una aceptación registrada. La reserva mantiene su estado.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar reserva", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: /acepto las normas de este espacio/ })
    .check();
  await page
    .getByRole("button", { name: "Aceptar normas", exact: true })
    .click();
  await expect(
    page.getByText("Tienes normas nuevas pendientes de aceptar"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Normas de la nueva pista")).toBeVisible();
});
test("history retains municipality on pagination and resets its cursor when scope changes", async ({
  page,
}) => {
  const seen: URL[] = [];
  await page.route("**/api/me/reservations*", async (r) => {
    const url = new URL(r.request().url());
    seen.push(url);
    if (!url.searchParams.has("tenantId"))
      return r.fulfill({
        json: {
          items: [
            { ...reservation, municipality: "Oleiros", unitName: "Pista 1" },
            {
              ...reservation,
              id: other,
              tenantId: other,
              municipality: "A Coruña",
              unitName: "Pista 2",
            },
          ],
          nextCursor: null,
        },
      });
    await r.fulfill({
      json: {
        items: [
          {
            ...reservation,
            id: url.searchParams.has("after") ? other : id,
            municipality: "Oleiros",
            unitName: "Pista 1",
          },
        ],
        nextCursor: url.searchParams.has("after")
          ? null
          : `2026-12-01T10:00:00.000000Z|${id}|${tenant}`,
      },
    });
  });
  await page.goto("/reservas");
  await page.getByRole("combobox", { name: "Municipio", exact: true }).click();
  await page.getByRole("option", { name: "Oleiros", exact: true }).click();
  await page.getByRole("button", { name: "Ver más reservas" }).click();
  await expect
    .poll(() =>
      seen.some(
        (u) =>
          u.searchParams.get("tenantId") === tenant &&
          u.searchParams.has("after"),
      ),
    )
    .toBe(true);
  await page.getByRole("combobox", { name: "Municipio", exact: true }).click();
  await page.getByRole("option", { name: "A Coruña", exact: true }).click();
  await expect
    .poll(() => seen.at(-1)?.searchParams.get("tenantId"))
    .toBe(other);
  expect(seen.at(-1)?.searchParams.has("after")).toBe(false);
});
test("checkout remains accessible and a quota rejection never appears as a confirmed reservation", async ({
  page,
}) => {
  await page.route(`**${path}`, (r) =>
    r.fulfill({
      status: 409,
      json: {
        error: {
          code: "QUOTA_EXCEEDED",
          message: "Has alcanzado el límite de reservas del convenio.",
        },
      },
    }),
  );
  await page.goto(checkout);
  await expect(
    page.getByRole("heading", { name: "Revisa tu reserva" }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/checkout-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("checkbox", { name: /He leído y acepto las normas de uso/ })
    .check();
  await page
    .getByRole("button", { name: "Confirmar reserva", exact: true })
    .click();
  await expect(
    page.getByText("Has alcanzado el límite de reservas del convenio."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/reservar\?/);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.reservation-command"),
    ),
  ).toBeNull();
});

test("a deadline rejection leaves the reservation confirmed and never invents a cancellation", async ({
  page,
}) => {
  await page.route(`**${path}/${id}/cancel`, (r) =>
    r.fulfill({
      status: 409,
      json: {
        error: {
          code: "RESERVATION_DEADLINE_PASSED",
          message:
            "El plazo de cancelación ha terminado. La reserva no se ha cancelado.",
        },
      },
    }),
  );
  await page.goto(detail);
  await page
    .getByRole("button", { name: "Cancelar reserva", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Cancelar reserva", exact: true })
    .click();
  await expect(
    page.getByText(
      "El plazo de cancelación ha terminado. La reserva no se ha cancelado.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reserva cancelada", exact: true }),
  ).toHaveCount(0);
});

test("an expired session retains the pending command for explicit recovery after sign-in", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "quenda.reservation-command",
      JSON.stringify({
        owner: "ana",
        key: "pending",
        body: "{}",
        path: "/api/municipalities/00000000-0000-4000-8000-000000000001/reservations",
        createdAt: Date.now(),
        retentionSeconds: 3600,
      }),
    ),
  );
  await page.route("**/api/me", (r) =>
    r.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHENTICATED", message: "Sesión requerida" } },
    }),
  );
  await page.goto("/reservas/recuperacion");
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("quenda.reservation-command")),
    )
    .toContain('"key":"pending"');
});

for (const skew of [-600000, 600000])
  test(`audit regression: recovery uses server time with browser skew ${skew}`, async ({
    page,
  }) => {
    const now = Date.now();
    await page.clock.setFixedTime(now + skew);
    await page.addInitScript(
      ({ now, path }) =>
        sessionStorage.setItem(
          "quenda.reservation-command",
          JSON.stringify({
            owner: "ana",
            path,
            key: "clock-regression",
            body: "{}",
            createdAt: now,
            retentionSeconds: 3600,
          }),
        ),
      { now, path },
    );
    await page.goto("/reservas/recuperacion");
    await expect(
      page.getByRole("button", {
        name: "Comprobar con la misma solicitud",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("El plazo de reintento ha terminado.", { exact: false }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "Comprobar con la misma solicitud",
        exact: true,
      }),
    ).toBeVisible();
    let recovered = false;
    await page.route("**/api/public/reservation-command-policy", (route) =>
      recovered
        ? route.fulfill({
            json: {
              retentionSeconds: 3600,
              serverTime: new Date(now + 3600000).toISOString(),
            },
          })
        : route.abort("failed"),
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      window.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      window.dispatchEvent(new Event("visibilitychange"));
    });
    const retry = page.getByRole("button", { name: "Reintentar", exact: true });
    await expect(retry).toBeVisible();
    await expect(
      page.getByText("El plazo de reintento ha terminado.", { exact: false }),
    ).toHaveCount(0);
    recovered = true;
    await retry.click();
    await expect(
      page.getByText("El plazo de reintento ha terminado.", { exact: false }),
    ).toBeVisible();
    expect(
      JSON.parse(
        (await page.evaluate(() =>
          sessionStorage.getItem("quenda.reservation-command"),
        )) ?? "null",
      ).key,
    ).toBe("clock-regression");
  });

for (const failure of ["429", "503", "offline"] as const)
  test(`audit regression: ${failure} pagination stops until explicit recovery`, async ({
    page,
  }) => {
    let attempts = 0;
    let recover = false;
    await page.route("**/availability?*", (route) =>
      route.fulfill({ json: { slots: [] } }),
    );
    await page.route(
      `**/api/public/municipalities/${tenant}/units/${unit}`,
      (route) =>
        route.fulfill({
          json: {
            id: unit,
            facilityId: other,
            facilityName: "Centro",
            municipalAdvanceDays: 30,
            cancellationMinutes: 1440,
            usageRulesVersion: 1,
            bookingPolicyVersion: 1,
            calendarVersion: 1,
            calendar: {
              minimumMinutes: 60,
              maximumMinutes: 120,
              stepMinutes: 60,
              advanceDays: null,
            },
            name: "Pista 1",
            timeZone: "Europe/Madrid",
          },
        }),
    );
    await page.route(
      `**/api/public/municipalities/${tenant}/facilities`,
      (route) =>
        route.fulfill({
          json: {
            items: [{ id: other, name: "Centro", units: 21 }],
            nextCursor: null,
          },
        }),
    );
    await page.route(
      `**/api/public/municipalities/${tenant}/facilities/${other}/units*`,
      (route) => {
        if (new URL(route.request().url()).searchParams.has("after")) {
          attempts++;
          if (recover)
            return route.fulfill({
              json: {
                items: [{ id: other, name: "Otra pista" }],
                nextCursor: null,
              },
            });
          if (failure === "offline") return route.abort("failed");
          return route.fulfill({
            status: Number(failure),
            headers: { "retry-after": "60" },
            json: {
              error: { code: "RATE_LIMITED", message: "Espera para continuar" },
            },
          });
        }
        return route.fulfill({
          json: { items: [{ id: unit, name: "Pista 1" }], nextCursor: unit },
        });
      },
    );
    await page.goto(`${detail}/modificar`);
    const retry = page.getByRole("button", { name: "Reintentar", exact: true });
    await expect(retry).toBeVisible();
    if (failure !== "offline") await expect(retry).toBeDisabled();
    expect(attempts).toBe(1);
    await page.clock.install();
    await page.clock.fastForward(61000);
    await expect(retry).toBeEnabled();
    expect(attempts).toBe(1);
    recover = true;
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect.poll(() => attempts).toBe(2);
    await expect(
      page.getByRole("combobox", { name: "Instalación", exact: true }),
    ).toContainText("Centro");
  });
test("the municipality filter lists every municipality even when the first history page shows only one", async ({
  page,
}) => {
  await page.route("**/api/me/reservations*", (route) =>
    route.fulfill({
      json: {
        items: [
          { ...reservation, municipality: "Oleiros", unitName: "Pista 1" },
        ],
        nextCursor: `2026-12-01T10:00:00.000000Z|${id}|${tenant}`,
      },
    }),
  );
  await page.goto("/reservas");
  await page.getByRole("combobox", { name: "Municipio", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Oleiros", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "A Coruña", exact: true }),
  ).toBeVisible();
});

test("homonymous municipalities in the filter are told apart", async ({
  page,
}) => {
  await page.route("**/api/me/reservations/municipalities", (route) =>
    route.fulfill({
      json: {
        items: [
          { tenantId: tenant, name: "Oleiros" },
          { tenantId: other, name: "Oleiros" },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/reservas");
  await page.getByRole("combobox", { name: "Municipio", exact: true }).click();
  await expect(
    page.getByRole("option", {
      name: new RegExp(`Oleiros · ${tenant.slice(-6)}`),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: new RegExp(`Oleiros · ${other.slice(-6)}`),
    }),
  ).toBeVisible();
});

test("expired sessions offer sign-in with the exact return path and keep uncertain commands", async ({
  page,
}) => {
  let reads = 0;
  await page.route(`**${path}/${id}`, async (route) => {
    reads++;
    await route.fulfill({
      status: 401,
      json: {
        error: { code: "UNAUTHENTICATED", message: "La sesión ha terminado." },
      },
    });
  });
  await page.goto(`${detail}?origen=avisos`);
  const back = page.getByRole("link", { name: "Volver a iniciar sesión" });
  await expect(back).toHaveAttribute(
    "href",
    `/acceso?returnTo=${encodeURIComponent(`${detail}?origen=avisos`)}`,
  );
  await page.evaluate(() =>
    sessionStorage.setItem("quenda.privacy-uncertain:ana:scope", "pending"),
  );
  const readsBeforeSignIn = reads;
  await back.click();
  await expect(page).toHaveURL(/\/acceso\?returnTo=/);
  await expect(
    page.getByRole("heading", {
      name: /Accede a tu cuenta|Accede á túa conta/,
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("quenda.privacy-uncertain:ana:scope"),
    ),
  ).toBe("pending");
  expect(reads).toBe(readsBeforeSignIn);
});

test("document titles follow route headings after navigation", async ({
  page,
}) => {
  await page.goto("/reservas");
  await expect(page).toHaveTitle(/Mis reservas.*Quenda/);
  await page.getByRole("link", { name: /Pista 1/ }).click();
  await expect(page).toHaveURL(new RegExp(detail));
  await expect(page).toHaveTitle(/Reserva.*Quenda/);
});
