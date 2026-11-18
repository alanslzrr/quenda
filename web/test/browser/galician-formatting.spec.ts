import { expect, type Locator, type Page } from "@playwright/test";
import { fieldValue, pickDate } from "./date-fields";
import { test } from "./fixtures";

// Chromium ships no Galician locale data: asked for `gl` it answers in the root locale ("2024 M03",
// "Fri", "1,234.5") or, on a Spanish system, in Spanish. A Galician browser on the desktop project
// shows that the app still names months and days and groups numbers as Galician does.
test.use({ locale: "gl-ES", timezoneId: "Europe/Madrid" });
test.skip(
  ({ isMobile }) => isMobile,
  "The phone and tablet projects already run in Galician",
);

const tenant = "00000000-0000-4000-8000-000000000001",
  unit = "00000000-0000-4000-8000-000000000002",
  reservationId = "00000000-0000-4000-8000-000000000003";
const view = `/administracion/${tenant}`,
  base = `/api/municipalities/${tenant}`;

/** What a runtime without Galician data prints for months, weekdays and grouping. */
const rootLocale =
  /M\d{2}\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;
const noRootLocale = (scope: Locator) =>
  expect(scope).not.toContainText(rootLocale);

// Thursday 10 January 2030, 10:00–11:00 in Madrid.
const startsAt = "2030-01-10T09:00:00.000Z",
  endsAt = "2030-01-10T10:00:00.000Z";

const analytics = {
  tenantId: tenant,
  unitId: null,
  from: "2024-03-01",
  to: "2024-04-01",
  timeZone: "Europe/Madrid",
  asOf: "2024-04-02T00:00:00Z",
  granularity: "day",
  summary: {
    reservations: { CONFIRMADA: 0, CANCELADA: 0, FINALIZADA: 0 },
    reservedMinutes: 0,
    // 1234 hours: Galician groups four digits ("1.234"); Spanish does not ("1234").
    offeredMinutes: 1234 * 60,
    occupancyPercent: 0,
  },
  series: [],
  weekdayHours: [],
  units: [],
  cancellations: {
    reservations: 0,
    cancelled: 0,
    byHolder: 0,
    administrative: 0,
    cancelledPercent: null,
  },
  leadTime: {
    lessThanOneDay: 0,
    oneToThreeDays: 0,
    threeToSevenDays: 0,
    sevenToFourteenDays: 0,
    fourteenDaysOrMore: 0,
  },
  attendance: { finished: 0, arrived: 0, arrivedPercent: null },
};

async function api(page: Page) {
  const yesterday = new Date(Date.now() - 86_400_000);
  yesterday.setHours(12, 0, 0, 0);
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    let body: unknown = { items: [], nextCursor: null };
    if (path === "/api/me")
      body = {
        accountId: "ana",
        email: "ana@example.test",
        mfaVerified: true,
      };
    else if (path === "/api/me/preferences") body = { locale: "gl" };
    else if (path === "/api/me/theme") body = { theme: "light" };
    else if (path === "/api/me/navigation")
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
    else if (path === "/api/me/notices/unread") body = { unread: 1 };
    else if (path === "/api/me/notices")
      body = {
        items: [
          {
            eventId: "event-1",
            tenantId: tenant,
            reservationId,
            revision: 1,
            kind: "CONFIRMADA",
            occurredAt: yesterday.toISOString(),
            administrative: false,
            actorName: null,
            reason: null,
            municipality: "Oleiros",
            unitName: "Pista 1",
            facilityName: "Centro",
            startsAt,
            endsAt,
            timeZone: "Europe/Madrid",
            pendingUsageRulesVersion: null,
            readAt: null,
          },
        ],
        nextCursor: null,
      };
    else if (path === "/api/me/reservations")
      body = {
        items: [
          {
            id: reservationId,
            tenantId: tenant,
            accountId: "ana",
            unitId: unit,
            startsAt,
            endsAt,
            status: "CONFIRMADA",
            revision: 1,
            timeZone: "Europe/Madrid",
            municipality: "Oleiros",
            unitName: "Pista 1",
          },
        ],
        nextCursor: null,
      };
    else if (path === `${base}/analytics/settings`)
      body = {
        version: 1,
        highDemandPercent: 85,
        lowUsePercent: 20,
        defaultPeriod: "THIS_MONTH",
      };
    else if (path === `${base}/analytics/units`)
      body = { units: [], truncated: false };
    else if (path === `${base}/analytics`) body = analytics;
    else if (path.endsWith("command-policy"))
      body = { serverTime: new Date().toISOString(), retentionSeconds: 3600 };
    await r.fulfill({ json: body });
  });
}

test("municipal screens name months and group numbers in Galician", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "runtime Galician data",
    description: JSON.stringify(
      await page.evaluate(() => Intl.DateTimeFormat.supportedLocalesOf(["gl"])),
    ),
  });
  await api(page);

  await page.goto(
    `${view}/uso-de-los-espacios?desde=2024-03-01&hasta=2024-03-31`,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Uso dos espazos" }),
  ).toBeVisible();
  await expect(
    page.getByText("De 1.234 h ofertadas", { exact: true }),
  ).toBeVisible();
  await noRootLocale(page.getByRole("main"));

  // The month picker names every month, short in the grid and long once chosen.
  await page.goto(`${view}/informes`);
  const month = page.getByRole("group", { name: "Mes publicado", exact: true });
  await month.getByRole("button").first().click();
  const months = page.getByRole("dialog").last();
  const shown = Number(
    (
      await months.locator("[data-month]").first().getAttribute("data-month")
    )?.slice(0, 4),
  );
  for (let year = shown; year > 2024; year--)
    await months
      .getByRole("button", { name: "Ano anterior", exact: true })
      .click();
  await expect(months.locator('[data-month="2024-01"]')).toHaveText("xan");
  await expect(months.locator('[data-month="2024-05"]')).toHaveText("maio");
  await expect(months.locator('[data-month="2024-12"]')).toHaveText("dec");
  await expect(months.locator('[data-month="2024-03"]')).toHaveAccessibleName(
    "marzo de 2024",
  );
  await noRootLocale(months);
  await months.locator('[data-month="2024-03"]').click();
  await expect(fieldValue(page, "Mes publicado")).toHaveValue("2024-03");
  await expect(month).toContainText("marzo de 2024");

  // The date picker writes the chosen day with the Galician abbreviated month.
  await page.goto(`${view}/exportaciones`);
  await pickDate(page, "Desde (incluído)", "2024-03-01");
  const from = page.getByRole("group", {
    name: "Desde (incluído)",
    exact: true,
  });
  await expect(from).toContainText("1 de mar. de 2024");
  await from.getByRole("button").first().click();
  const calendar = page.getByRole("dialog").last();
  await expect(
    calendar.getByRole("heading", { name: "marzo 2024" }),
  ).toBeVisible();
  await expect(
    calendar.getByRole("gridcell", { name: "venres, 1 de marzo de 2024" }),
  ).toBeVisible();
  await noRootLocale(calendar);
});

test("a citizen reads booking dates and notice times in Galician", async ({
  page,
}) => {
  await api(page);
  await page.goto("/reservas");
  await expect(page.getByRole("main")).toContainText(
    "xoves, 10 de xaneiro · 10:00–11:00",
  );
  await noRootLocale(page.getByRole("main"));

  await page.goto("/avisos");
  await expect(page.locator("time", { hasText: /^onte$/ })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "xoves, 10 de xaneiro · 10:00–11:00",
  );
  await noRootLocale(page.getByRole("main"));
});
