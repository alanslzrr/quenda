import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { totp } from "../../../test/helpers/auth-client";
import { login } from "./account-helpers";
import { test } from "./fixtures";

interface Fixture {
  administrator: {
    tenant: string;
    email: string;
    password: string;
    secret: string;
  };
  holder: { email: string; password: string };
  reservationId: string;
}
const accessible = async (page: Page) =>
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

test("the holder's access code opens the staff check and records the arrival once", async ({
  page: holder,
  browser,
}, info) => {
  const f: Fixture = JSON.parse(
    await readFile("test-results/arrival-fixtures.json", "utf8"),
  )[info.project.name === "desktop" ? 0 : 1];
  const detail = `/reservas/${f.administrator.tenant}/${f.reservationId}`;

  await login(holder, f.holder.email, f.holder.password);
  await expect(holder).toHaveURL(/\/perfil$/);
  await holder.goto(detail);
  await expect(
    holder.getByRole("heading", {
      name: /Acceso a la instalación|Acceso á instalación/,
    }),
  ).toBeVisible();
  const code = holder.getByRole("img", {
    name: /Código QR de acceso de esta reserva|Código QR de acceso desta reserva/,
  });
  await expect(code).toBeVisible();
  await accessible(holder);

  // The code encodes the staff page; staff open it on their own signed-in phone.
  const staffPage = `/administracion/${f.administrator.tenant}/reservas/${f.reservationId}`;
  // Staff use their own device: a separate browser context and network identity.
  const staffContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: info.project.use.locale,
    viewport: info.project.use.viewport,
    extraHTTPHeaders: {
      "x-quenda-test-client": `2001:db8:530:${info.project.name === "desktop" ? 1 : 2}::1`,
    },
  });
  const staff = await staffContext.newPage();
  await login(staff, f.administrator.email, f.administrator.password);
  await staff
    .getByLabel(/^(Código de autenticación|Código de autenticación)$/)
    .fill(totp(f.administrator.secret));
  await staff.getByRole("button", { name: /^Verificar$/ }).click();
  await expect(staff).toHaveURL(/\/perfil$/);
  await staff.goto(staffPage);
  await expect(
    staff.getByText(
      /Reserva válida para este momento|Reserva válida para este momento/,
    ),
  ).toBeVisible();
  await accessible(staff);
  let posts = 0;
  staff.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/arrival"))
      posts++;
  });
  await staff
    .getByRole("button", { name: /^(Registrar llegada|Rexistrar chegada)$/ })
    .click();
  await expect(
    staff.getByText(/Llegada registrada|Chegada rexistrada/),
  ).toBeVisible();
  await expect(
    staff.getByRole("button", {
      name: /^(Registrar llegada|Rexistrar chegada)$/,
    }),
  ).toHaveCount(0);
  expect(posts).toBe(1);

  // The holder sees the record instead of the code.
  await holder.reload();
  await expect(
    holder.getByText(/Llegada registrada|Chegada rexistrada/),
  ).toBeVisible();
  await expect(code).toHaveCount(0);
  await staffContext.close();
});
