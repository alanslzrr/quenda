import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

const tenant = "00000000-0000-4000-8000-000000000001";
const unit = "00000000-0000-4000-8000-000000000003";
const resource = `/administracion/${tenant}/unidades/${unit}`;
const publicUnit = `/municipios/${tenant}/unidades/${unit}`;
const start = new Date(Date.now() + 48 * 3600000).toISOString();
const end = new Date(Date.parse(start) + 3600000).toISOString();
const bookingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(start));
function offset(instant: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Madrid",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(instant))
    .find((part) => part.type === "timeZoneName")
    ?.value.replace("GMT", "");
}

async function fixture(page: Page) {
  let theme = "light";
  let verified = false;
  const commands: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = {};
    let status = 200;
    if (path === "/api/me")
      body = {
        accountId: "design-review",
        email: "ana@example.test",
        mfaVerified: verified,
      };
    else if (path === "/api/me/preferences") body = { locale: "es" };
    else if (path === "/api/me/theme") {
      if (method === "PUT" || method === "PATCH")
        theme = route.request().postDataJSON().theme;
      body = { theme };
    } else if (path === "/api/me/navigation")
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
    else if (path === "/api/auth/get-session")
      body = {
        user: {
          id: "design-review",
          name: "Ana",
          email: "ana@example.test",
          twoFactorEnabled: true,
        },
        session: { token: "current", createdAt: start, expiresAt: end },
      };
    else if (path === "/api/auth/list-sessions")
      body = [
        {
          token: "current",
          createdAt: new Date().toISOString(),
          expiresAt: end,
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36",
        },
      ];
    else if (path === "/api/auth/two-factor/verify-totp") {
      verified = true;
      body = { status: true };
    } else if (path.endsWith("/appearance"))
      body = {
        version: 1,
        lightPalette: "neutral",
        darkPalette: "neutral",
        defaultTheme: "light",
      };
    else if (path === "/api/public/reservation-command-policy")
      body = { retentionSeconds: 3600, serverTime: new Date().toISOString() };
    else if (path.endsWith(`/units/${unit}`)) {
      if (!path.includes("/public/") && !verified) {
        status = 403;
        body = {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message:
              "Vuelve a verificar el segundo factor para realizar esta operación.",
          },
        };
      } else
        body = {
          id: unit,
          name: "Pista de tenis",
          facilityId: "facility",
          publishedAt: start,
          withdrawnAt: null,
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
    } else if (path.endsWith("/usage-rules")) {
      if (method === "PUT") {
        commands.push(route.request().postDataJSON());
        verified = false;
        status = 403;
        body = {
          error: {
            code: "REAUTHENTICATION_REQUIRED",
            message:
              "Vuelve a verificar el segundo factor para realizar esta operación.",
          },
        };
      } else
        body = {
          version: 1,
          text: "Respeta el horario reservado y deja la pista en buenas condiciones.",
        };
    } else if (path.endsWith("/calendar"))
      body = {
        version: 1,
        calendar: {
          minimumMinutes: 60,
          maximumMinutes: 120,
          stepMinutes: 30,
          advanceDays: null,
          weekly: [{ day: 1, startMinute: 540, endMinute: 1260 }],
          exceptions: [],
        },
      };
    else if (path.endsWith("/availability"))
      body = {
        unitId: unit,
        timeZone: "Europe/Madrid",
        date: new URL(route.request().url()).searchParams.get("date"),
        calculatedAt: new Date().toISOString(),
        slots:
          new URL(route.request().url()).searchParams.get("date") ===
          bookingDate
            ? [
                {
                  start: { utc: start, offset: offset(start) },
                  end: { utc: end, offset: offset(end) },
                  durationMinutes: 60,
                },
              ]
            : [],
      };
    else {
      status = 404;
      body = { error: { code: "NOT_FOUND", message: "No encontrado" } };
    }
    await route.fulfill({ status, json: body });
  });
  return { commands };
}
async function appearance(page: Page, theme: "light" | "dark") {
  await page.getByRole("button", { name: "Ajustes", exact: true }).click();
  const choice = page.getByRole("menuitem", {
    name: theme === "light" ? "Modo claro" : "Modo oscuro",
    exact: true,
  });
  if (await choice.isEnabled()) await choice.click();
  else await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(page.locator('[data-aria-hidden="true"]')).toHaveCount(0);
}
async function audit(page: Page, name: string) {
  // Audit the settled state, not intermediate colors during the calendar handoff.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getTiming().iterations === Infinity,
          ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/review-${name}.png`,
    fullPage: true,
  });
}

test("unit composition preserves drafts across tabs and contextual MFA without replay", async ({
  page,
}, info) => {
  const { commands } = await fixture(page);
  await page.goto(resource);
  await page
    .getByRole("alert")
    .getByRole("button", { name: "Verificar MFA" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill("123456");
  await dialog.getByRole("button", { name: "Verificar MFA" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Pista de tenis" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  const draft = "Normas editadas que deben conservarse al verificar.";
  await page.getByLabel("Texto de las normas").fill(draft);
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  await expect(page.getByLabel("Texto de las normas")).toHaveValue(draft);
  const rules = page.getByRole("tabpanel", { name: "Normas", exact: true });
  await rules.getByLabel("Motivo").fill("Revisión municipal");
  await rules.getByRole("button", { name: "Guardar normas" }).click();
  await rules
    .getByRole("alert")
    .getByRole("button", { name: "Verificar MFA" })
    .click();
  await dialog
    .getByLabel("Código de autenticación", { exact: true })
    .fill("123456");
  await dialog.getByRole("button", { name: "Verificar MFA" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Texto de las normas")).toHaveValue(draft);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toEqual({
    expectedVersion: 1,
    text: draft,
    reason: "Revisión municipal",
  });
  await page.getByRole("tab", { name: "Datos", exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await appearance(page, theme);
    await audit(page, `unit-${info.project.name}-${theme}`);
  }
  if ((page.viewportSize()?.width ?? 1000) < 480) {
    await page
      .getByRole("button", { name: "Gestión municipal", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Gestión municipal", exact: true }),
    ).toBeFocused();
  }
});

test("booking composition exposes the real selection and explicit acceptance", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto(publicUnit);
  await expect(
    page.getByRole("heading", { name: "Pista de tenis" }),
  ).toBeVisible();
  await page
    .getByRole("gridcell", {
      name: new Intl.DateTimeFormat("es", {
        timeZone: "Europe/Madrid",
        dateStyle: "full",
      }).format(new Date(start)),
      exact: true,
    })
    .click();
  await expect(page.getByRole("link").filter({ hasText: "UTC" })).toHaveCount(
    1,
  );
  for (const theme of ["light", "dark"] as const) {
    await appearance(page, theme);
    await audit(page, `availability-${info.project.name}-${theme}`);
  }
  await page.getByRole("link").filter({ hasText: "UTC" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Confirmar reserva", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Acepto estas normas y las condiciones de cancelación.",
    }),
  ).not.toBeChecked();
  for (const theme of ["light", "dark"] as const) {
    await appearance(page, theme);
    await audit(page, `checkout-${info.project.name}-${theme}`);
  }
});

test("security composition reveals existing forms without exposing credentials in its overview", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto("/perfil/seguridad");
  await expect(
    page.getByRole("heading", { name: "Seguridad de tu cuenta" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Contraseña actual", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Chrome · macOS", { exact: true })).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await appearance(page, theme);
    await audit(page, `security-${info.project.name}-${theme}`);
  }
  await page
    .getByRole("button", { name: "Cambiar contraseña", exact: true })
    .click();
  await expect(
    page.getByLabel("Contraseña actual", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ocultar formulario", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Gestionar MFA", exact: true })
    .click();
  await expect(
    page.getByLabel("Código de autenticación", { exact: true }),
  ).toBeVisible();
});
