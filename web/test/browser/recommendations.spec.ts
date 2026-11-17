import { expect, type Page } from "@playwright/test";
import { accessibilityViolations } from "./axe-scan";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000081";
const unit = "00000000-0000-4000-8000-000000000082";
const either = (es: string, gl: string) => new RegExp(`^(?:${es}|${gl})$`);

test.use({ reducedMotion: "reduce" });

async function fixture(page: Page) {
  const state = { enabled: true, saved: [] as boolean[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: {
          accountId: "titular",
          email: "titular@example.test",
          mfaVerified: false,
        },
      });
    if (path === "/api/me/preferences")
      return route.fulfill({ json: { locale: null } });
    if (path === "/api/me/theme")
      return route.fulfill({ json: { theme: "light" } });
    if (path === "/api/me/calendar-subscription")
      return route.fulfill({ json: { active: false, createdAt: null } });
    if (path === "/api/me/recommendations") {
      if (request.method() === "PUT") {
        state.enabled = request.postDataJSON().enabled;
        state.saved.push(state.enabled);
        return route.fulfill({ json: { enabled: state.enabled } });
      }
      return route.fulfill({
        json: {
          enabled: state.enabled,
          items: state.enabled
            ? [
                {
                  tenantId: tenant,
                  municipality: "Oleiros",
                  unitId: unit,
                  unitName: "Pista 1",
                  facilityName: "Polideportivo",
                  weekday: 2,
                  startMinute: 1140,
                  durationMinutes: 60,
                  occurrences: 3,
                  slot: {
                    start: {
                      utc: "2026-11-17T18:00:00.000Z",
                      local: "2026-11-17T19:00",
                      offset: "+01:00",
                      timeZone: "Europe/Madrid",
                    },
                    end: {
                      utc: "2026-11-17T19:00:00.000Z",
                      local: "2026-11-17T20:00",
                      offset: "+01:00",
                      timeZone: "Europe/Madrid",
                    },
                    durationMinutes: 60,
                  },
                },
              ]
            : [],
        },
      });
    }
    if (path === "/api/me/navigation")
      return route.fulfill({
        json: {
          platform: { operator: false, permissions: [] },
          municipalities: { items: [], nextCursor: null },
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

test("the history offers the holder's habitual slots and lets them turn the offer off", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/reservas");
  const section = page.getByRole("region", {
    name: either("Tus horarios habituales", "Os teus horarios habituais"),
  });
  await expect(section).toBeVisible();
  await expect(section).toContainText(
    /Sueles reservar los martes a las 19:00, 1 h\.|Adoitas reservar os martes ás 19:00, 1 h\./,
  );
  await expect(section).toContainText("Polideportivo · Oleiros");
  const book = section.getByRole("link", {
    name: either(
      "Reservar el mar 17 nov · 19:00, Pista 1",
      "Reservar o mar 17 nov · 19:00, Pista 1",
    ),
  });
  await expect(book).toHaveAttribute(
    "href",
    `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent("2026-11-17T18:00:00.000Z")}&fin=${encodeURIComponent("2026-11-17T19:00:00.000Z")}`,
  );
  expect(await accessibilityViolations(page, { allRules: true })).toEqual([]);

  await section
    .getByRole("button", {
      name: either("No mostrar recomendaciones", "Non amosar recomendacións"),
    })
    .click();
  await expect(section).toHaveCount(0);
  expect(state.saved).toEqual([false]);

  // The account privacy page shows the choice and turns it back on.
  await page.goto("/perfil/privacidad");
  const choice = page.getByRole("checkbox", {
    name: either(
      "Mostrar recomendaciones de horario",
      "Amosar recomendacións de horario",
    ),
  });
  await expect(choice).not.toBeChecked();
  expect(await accessibilityViolations(page, { allRules: true })).toEqual([]);
  await choice.click();
  await expect(choice).toBeChecked();
  expect(state.saved).toEqual([false, true]);
  await page.goto("/reservas");
  await expect(
    page.getByRole("region", {
      name: either("Tus horarios habituales", "Os teus horarios habituais"),
    }),
  ).toBeVisible();
});

test("without habits the history shows no recommendation block", async ({
  page,
}) => {
  const state = await fixture(page);
  state.enabled = false;
  await page.goto("/reservas");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: either("Mis reservas", "As miñas reservas"),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: either("Tus horarios habituales", "Os teus horarios habituais"),
    }),
  ).toHaveCount(0);
});
