import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  access,
  account,
  Capture,
  expect,
  latestMail,
  mailUrl,
  roles,
  test,
} from "./capture";
import {
  book,
  freeSlots,
  madridDate,
  runMailWorker,
  shot,
  signInWith,
  valdeira,
} from "./citizen";

// CU-11 — Recibir y consultar avisos de reserva. La vecina reserva y cancela;
// el worker de correo entrega los mensajes y la web muestra los avisos.
const cu = new Capture("CU-11");

/** Whether the mail sink already holds a message to `to` mentioning `text`. */
async function delivered(to: string, text: string) {
  const { mail } = await access();
  for (const file of await readdir(mail).catch(() => [] as string[])) {
    const message = JSON.parse(await readFile(path.join(mail, file), "utf8"));
    if (message.to === to && message.text.includes(text)) return true;
  }
  return false;
}

test("CU-11 recibir y consultar avisos de reserva", async ({ page }) => {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);
  const origin = new URL(page.url()).origin;
  const [slot] = await freeSlots(
    page,
    valdeira.id,
    valdeira.court,
    madridDate(27),
  );
  if (!slot) throw new Error("No free slot");
  const reservation = await book(page, valdeira.id, valdeira.court, slot);

  // Paso 1: Quenda registra el aviso y el worker envía el correo (sin
  // captura: la persona solo ve el resultado).
  await runMailWorker(origin, () => delivered(email, reservation.id));

  // Paso 2: el correo describe el evento y enlaza la reserva.
  const message = await latestMail(email, reservation.id);
  await cu.mail(page, "correo-de-confirmacion", message);

  // Paso 2: en la web, «Ajustes» señala los avisos sin leer.
  await page.goto("/reservas");
  const settings = page.getByRole("button", { name: "Ajustes", exact: true });
  await expect(settings).toHaveAccessibleDescription(/sin leer$/);
  await shot(cu, page, "avisos-sin-leer", { target: settings });
  await settings.click();
  const notices = page.getByRole("menuitem", { name: /^Avisos/ });
  await expect(notices).toBeVisible();
  await shot(cu, page, "menu-avisos", { target: notices });
  await notices.click();

  const latest = page
    .getByRole("link")
    .filter({ hasText: "Reserva confirmada · Pista central" })
    .first();
  await expect(latest).toBeVisible();
  await shot(cu, page, "lista-de-avisos", { target: latest });

  // Paso 3: el aviso lleva a la reserva y su estado actual.
  await latest.click();
  await expect(page).toHaveURL(new RegExp(reservation.id));
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();
  await shot(cu, page, "reserva-enlazada");

  // El enlace del correo abre la misma reserva.
  await page.goto(mailUrl(message));
  await expect(
    page.getByRole("heading", { name: "Reserva confirmada", exact: true }),
  ).toBeVisible();

  // Una cancelación genera su propio aviso y su correo.
  const cancelled = await page.request.post(
    `/api/municipalities/${valdeira.id}/reservations/${reservation.id}/cancel`,
    {
      headers: { "Idempotency-Key": randomUUID(), Origin: origin },
      data: { expectedRevision: reservation.revision },
    },
  );
  expect(cancelled.ok()).toBe(true);
  await runMailWorker(origin, async () => {
    const last = await latestMail(email, reservation.id);
    return /cancel/i.test(last.subject);
  });
  await cu.mail(
    page,
    "correo-de-cancelacion",
    await latestMail(email, reservation.id),
  );

  // Marcar todo como leído.
  await page.goto("/avisos");
  const markAll = page.getByRole("button", { name: "Marcar todo como leído" });
  await expect(markAll).toBeVisible();
  await shot(cu, page, "marcar-todo-como-leido", { target: markAll });
  await markAll.click();
  await expect(markAll).toHaveCount(0);
  await expect(settings).toHaveAccessibleDescription("");
  await shot(cu, page, "avisos-leidos");
});
