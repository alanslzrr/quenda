import AxeBuilder from "@axe-core/playwright";
import { expect, request, test } from "@playwright/test";
import { createAccount } from "./account-helpers";

test("a holder creates, replaces and withdraws a calendar subscription URL", async ({
  page,
  baseURL,
}) => {
  await createAccount(page);
  await page.goto("/reservas");
  await page
    .getByRole("button", {
      name: /Sincronizar con mi aplicación de calendario|Sincronizar coa miña aplicación de calendario/,
    })
    .click();
  await page
    .getByRole("button", {
      name: /^(Crear dirección de suscripción|Crear enderezo de subscrición)$/,
    })
    .click();
  const field = page.getByLabel(
    /^(Dirección de suscripción|Enderezo de subscrición)$/,
  );
  await expect(field).toBeVisible();
  const first = await field.inputValue();
  expect(first).toMatch(
    /\/api\/calendars\/[A-Za-z0-9_-]{43}\.ics\?lang=(es|gl)$/,
  );
  await expect(
    page.getByRole("link", {
      name: /Abrir en mi aplicación de calendario|Abrir na miña aplicación de calendario/,
    }),
  ).toHaveAttribute("href", first.replace(/^https?:/, "webcal:"));
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  // A calendar application has no session: the URL alone must work.
  const calendarApp = await request.newContext({ baseURL });
  const fetchFeed = (url: string) =>
    calendarApp.get(new URL(url).pathname + new URL(url).search);
  const feed = await fetchFeed(first);
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toMatch(/^text\/calendar/);
  expect(await feed.text()).toContain("BEGIN:VCALENDAR");

  // After a reload the URL is no longer shown, only that a subscription exists.
  await page.reload();
  await page
    .getByRole("button", {
      name: /Sincronizar con mi aplicación de calendario|Sincronizar coa miña aplicación de calendario/,
    })
    .click();
  await expect(
    page.getByText(/Tienes una suscripción activa|Tes unha subscrición activa/),
  ).toBeVisible();
  await expect(field).toHaveCount(0);

  await page
    .getByRole("button", {
      name: /^(Generar una dirección nueva|Xerar un enderezo novo)$/,
    })
    .click();
  await expect(field).toBeVisible();
  const second = await field.inputValue();
  expect(second).not.toBe(first);
  expect((await fetchFeed(first)).status()).toBe(404);
  expect((await fetchFeed(second)).status()).toBe(200);

  await page
    .getByRole("button", {
      name: /^(Retirar la suscripción|Retirar a subscrición)$/,
    })
    .click();
  await expect(
    page.getByText(/Suscripción retirada|Subscrición retirada/),
  ).toBeVisible();
  await expect(field).toHaveCount(0);
  expect((await fetchFeed(second)).status()).toBe(404);
  await calendarApp.dispose();
});
