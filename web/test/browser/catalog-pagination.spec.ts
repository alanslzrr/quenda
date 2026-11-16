import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000001";
const facility = "00000000-0000-4000-8000-000000000002";
const unit = "00000000-0000-4000-8000-000000000003";
const municipalPath = `/api/public/municipalities/${tenant}`;
const lists = {
  "/api/public/municipalities": [
    { id: tenant, name: "Valdeira", timeZone: "Europe/Madrid" },
  ],
  [`${municipalPath}/facilities`]: [
    { id: facility, name: "Sede Valdeira", units: 1 },
  ],
  [`${municipalPath}/facilities/${facility}/units`]: [
    {
      id: unit,
      name: "Pista Valdeira",
      facilityId: facility,
      minimumMinutes: 60,
      maximumMinutes: 120,
    },
  ],
  [`${municipalPath}/availability-search`]: [],
};

for (const scenario of [
  {
    endpoint: "/api/public/municipalities",
    path: "/reservar",
    name: "Valdeira",
  },
  {
    endpoint: `${municipalPath}/facilities`,
    path: `/municipios/${tenant}`,
    name: "Sede Valdeira",
  },
  {
    endpoint: `${municipalPath}/facilities/${facility}/units`,
    path: `/municipios/${tenant}/instalaciones/${facility}`,
    name: "Pista Valdeira",
  },
  {
    endpoint: `${municipalPath}/availability-search`,
    path: `/municipios/${tenant}/horarios`,
    name: "Horarios",
  },
]) {
  test(`pagination waits for explicit recovery after 429: ${scenario.name}`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-24T12:00:00Z") });
    let secondPageAttempts = 0;
    let recover = false;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const items = lists[path as keyof typeof lists];
      if (path === scenario.endpoint && url.searchParams.has("after")) {
        secondPageAttempts++;
        await route.fulfill(
          recover
            ? { json: { items: [], nextCursor: null } }
            : {
                status: 429,
                headers: { "Retry-After": "60" },
                json: {
                  error: { code: "RATE_LIMITED", message: "Espera un minuto." },
                },
              },
        );
      } else if (items)
        await route.fulfill({
          json: {
            items,
            nextCursor: path === scenario.endpoint ? "page-two" : null,
          },
        });
      else if (path === municipalPath)
        await route.fulfill({
          json: { id: tenant, name: "Valdeira", timeZone: "Europe/Madrid" },
        });
      else if (path.endsWith("/booking-durations"))
        await route.fulfill({
          json: { durations: [60, 90, 120], hasMore: false, recommended: 60 },
        });
      else if (path.endsWith("/appearance"))
        await route.fulfill({
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
      else
        await route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED", message: "Accede." } },
        });
    });
    await page.goto(scenario.path);
    await expect(page.getByRole("alert")).toContainText("Espera un minuto.");
    const retry = page.getByRole("button", {
      name: /^(Reintentar|Tentar de novo)$/,
    });
    await expect(retry).toBeDisabled();
    await page.clock.runFor(5000);
    expect(secondPageAttempts).toBe(1);
    recover = true;
    await page.clock.fastForward(61000);
    await expect(retry).toBeEnabled();
    // Expiry alone never loops; the user's explicit retry resumes pagination.
    expect(secondPageAttempts).toBe(1);
    await retry.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    if (scenario.name === "Horarios")
      await expect(
        page.getByText(/(No|Non) quedan horarios libres/),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("main").getByRole("link", {
          name: new RegExp(`^${scenario.name}`),
        }),
      ).toBeVisible();
    expect(secondPageAttempts).toBe(2);
  });
}
