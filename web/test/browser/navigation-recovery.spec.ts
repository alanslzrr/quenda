import { expect, test } from "@playwright/test";

const tenant = "00000000-0000-4000-8000-000000000081";

test.use({ reducedMotion: "reduce" });

test("a failed navigation projection exposes a cooldown and explicit recovery without inventing permissions", async ({
  page,
}, info) => {
  // Freezing timers would also freeze TanStack Query's batched notifications.
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:00Z"));
  let allowed = false;
  let requests = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/me")
      body = {
        accountId: "admin",
        email: "admin@demo.test",
        mfaVerified: true,
      };
    else if (path === "/api/me/navigation") {
      requests += 1;
      if (!allowed) {
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
    } else if (path === "/api/me/preferences") body = { locale: "es" };
    else if (path === "/api/me/theme")
      body = { theme: info.project.name.includes("dark") ? "dark" : "light" };
    else if (path === "/api/public/municipalities")
      body = {
        items: [{ id: tenant, name: "Oleiros", timeZone: "Europe/Madrid" }],
        nextCursor: null,
      };
    else throw new Error(`Unexpected request: ${path}`);
    await route.fulfill({ json: body });
  });
  await page.goto("/reservar");
  const recovery = page.getByRole("region", {
    name: "Acceso a gestión",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  const navigation = page.getByRole("navigation", {
    name: "Navegación principal",
    exact: true,
  });
  await expect(
    navigation.getByRole("link", { name: "Gestión", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Reservar", exact: true }),
  ).toBeVisible();
  const retry = recovery.getByRole("button", {
    name: "Reintentar acceso a gestión",
    exact: true,
  });
  await expect(retry).toBeDisabled();
  const baseline = requests;
  await page.clock.setFixedTime(new Date("2026-10-24T12:00:03.500Z"));
  await expect(retry).toBeEnabled();
  expect(requests).toBe(baseline);
  allowed = true;
  await retry.click();
  await expect(recovery).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Gestión", exact: true }),
  ).toHaveAttribute("href", `/administracion/${tenant}`);
  expect(requests).toBe(baseline + 1);
});
