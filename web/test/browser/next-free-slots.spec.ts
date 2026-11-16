import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000081";
const facility = "00000000-0000-4000-8000-000000000082";
const unit = "00000000-0000-4000-8000-000000000083";
const page26 = `/municipios/${tenant}/unidades/${unit}?fecha=2026-10-26&duracion=60`;
const slot = (date: string, time: string) => {
  const start = new Date(`${date}T${time}:00+01:00`);
  const end = new Date(start.getTime() + 3600000);
  return {
    start: {
      utc: start.toISOString(),
      local: `${date}T${time}`,
      offset: "+01:00",
    },
    end: {
      utc: end.toISOString(),
      local: `${date}T${String(Number(time.slice(0, 2)) + 1).padStart(2, "0")}${time.slice(2)}`,
      offset: "+01:00",
    },
    durationMinutes: 60,
  };
};

test("a full day suggests the next free slots and links straight to booking them", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  let suggested = "";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/me") {
      await route.fulfill({
        status: 401,
        json: {
          error: { code: "UNAUTHENTICATED", message: "Sesión requerida" },
        },
      });
      return;
    }
    if (url.pathname === "/api/public/municipalities")
      body = {
        items: [{ id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" }],
        nextCursor: null,
      };
    else if (url.pathname.endsWith(`/municipalities/${tenant}`))
      body = { id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" };
    else if (url.pathname.endsWith("/appearance"))
      body = {
        version: 1,
        theme: "neutral",
        light: {},
        dark: {},
        font: "inter",
        corners: "round",
        defaultTheme: "light",
      };
    else if (url.pathname.endsWith("/branding"))
      body = {
        version: 1,
        name: "Oleiros",
        officialName: "Oleiros",
        logos: { light: false, dark: false },
      };
    else if (url.pathname.endsWith(`/units/${unit}`))
      body = {
        id: unit,
        name: "Pista 1",
        facilityId: facility,
        facilityName: "Centro deportivo",
        timeZone: "Europe/Madrid",
        municipalAdvanceDays: 30,
        cancellationMinutes: 1440,
        bookingPolicyVersion: 1,
        usageRulesVersion: 1,
        calendarVersion: 1,
        calendar: {
          minimumMinutes: 60,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
        },
      };
    else if (url.pathname.endsWith(`/units/${unit}/availability`))
      body = {
        unitId: unit,
        date: url.searchParams.get("date"),
        timeZone: "Europe/Madrid",
        calendarVersion: 1,
        calculatedAt: new Date().toISOString(),
        slots: [],
      };
    else if (url.pathname.endsWith(`/units/${unit}/next-availability`)) {
      suggested = url.search;
      body = {
        unitId: unit,
        from: url.searchParams.get("from"),
        timeZone: "Europe/Madrid",
        calendarVersion: 1,
        calculatedAt: new Date().toISOString(),
        slots: [slot("2026-10-27", "10:00"), slot("2026-10-27", "11:30")],
      };
    } else throw new Error(`Unexpected request: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.goto(page26);
  await expect(
    page.getByText(/No quedan horarios libres|Non quedan horarios libres/),
  ).toBeVisible();
  const heading = page.getByRole("heading", {
    name: "Próximos horarios libres",
  });
  await expect(heading).toBeVisible();
  expect(suggested).toBe("?from=2026-10-26&durationMinutes=60");
  const links = page
    .locator("ul")
    .filter({ has: page.getByRole("link", { name: /· 10:00$/ }) })
    .getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute(
    "href",
    `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent(slot("2026-10-27", "10:00").start.utc)}&fin=${encodeURIComponent(slot("2026-10-27", "10:00").end.utc)}`,
  );
  await expect(links.nth(1)).toHaveText(/· 11:30$/);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
