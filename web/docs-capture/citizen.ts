import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { access, type Capture, expect, latestMail, mailUrl } from "./capture";

// Shared steps of the citizen guide: seeded catalogue, civil dates in the
// municipalities' time zone, fresh accounts and the reservation mail worker.

export const valdeira = {
  id: "00000000-0000-4000-8000-00000000d100",
  fontela: "00000000-0000-4000-8000-00000000d110",
  padel1: "00000000-0000-4000-8000-00000000d111",
  padel2: "00000000-0000-4000-8000-00000000d112",
  tennis: "00000000-0000-4000-8000-00000000d113",
  football: "00000000-0000-4000-8000-00000000d114",
  remedios: "00000000-0000-4000-8000-00000000d120",
  court: "00000000-0000-4000-8000-00000000d121",
  hall: "00000000-0000-4000-8000-00000000d122",
};
export const ribasanta = {
  id: "00000000-0000-4000-8000-00000000d200",
  porto: "00000000-0000-4000-8000-00000000d210",
  pool: "00000000-0000-4000-8000-00000000d220",
  sportsCourt: "00000000-0000-4000-8000-00000000d211",
};

/** Civil date in Europe/Madrid, `offset` days from today. */
export function madridDate(offset = 0, from = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(from + offset * 86400000));
}

/** The instant of a civil date and time in Europe/Madrid. */
export function madridInstant(date: string, time: string) {
  const guess = new Date(`${date}T${time}:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    timeZoneName: "longOffset",
  })
    .formatToParts(guess)
    .find((part) => part.type === "timeZoneName")
    ?.value.replace("GMT", "");
  return new Date(`${date}T${time}:00${offset || "+00:00"}`);
}

/**
 * The browser's clock at 09:00 tomorrow in the municipality, so that a page
 * that opens on «today» shows a whole day of free slots whatever the time of
 * the run. The server keeps its own clock; tomorrow is a valid day for it.
 */
export async function morningClock(page: Page) {
  await page.clock.setFixedTime(madridInstant(madridDate(1), "09:00"));
}

/**
 * First Wednesday or Thursday at least `offset` days ahead: a calendar cell
 * in the middle of its row, so its outline is never cut by the popover edge.
 */
export function midweek(offset: number) {
  for (let day = offset; ; day++) {
    const date = madridDate(day);
    if ([3, 4].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return date;
  }
}

/** Opens the «Día» calendar and moves to the month of `date`. */
export async function openDay(page: Page, date: string) {
  await page
    .getByRole("group", { name: "Día", exact: true })
    .getByRole("button")
    .first()
    .click();
  const dialog = page.getByRole("dialog").last();
  const focused = dialog.locator('[data-present] [data-date][tabindex="0"]');
  await expect(focused).toBeFocused();
  const from = (await focused.getAttribute("data-date")) ?? date;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = date.split("-").map(Number);
  for (let months = (ty - fy) * 12 + (tm - fm); months > 0; months--)
    await dialog.getByRole("button", { name: "Mes siguiente" }).click();
  const day = dialog.locator(`[data-present] [data-date="${date}"]`);
  await expect(day).toBeVisible();
  return day;
}

/** Chooses `date` on the «Día» field of a booking page. */
export async function pickDay(page: Page, date: string) {
  const day = await openDay(page, date);
  await day.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

type Slot = { start: { utc: string; local: string }; end: { utc: string } };
/** Free slots of a unit on a civil date, from the public availability. */
export async function freeSlots(
  page: Page,
  tenant: string,
  unit: string,
  date: string,
  minutes = 60,
) {
  const response = await page.request.get(
    `/api/public/municipalities/${tenant}/units/${unit}/availability?date=${date}&durationMinutes=${minutes}`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { slots: Slot[] }).slots;
}

/** Books a slot through the API with the page's session, as the app does. */
export async function book(
  page: Page,
  tenant: string,
  unit: string,
  slot: Slot,
  nonCancellable = false,
) {
  const response = await page.request.post(
    `/api/municipalities/${tenant}/reservations`,
    {
      headers: {
        "Idempotency-Key": randomUUID(),
        Origin: new URL(page.url()).origin,
      },
      data: {
        unitId: unit,
        startsAt: slot.start.utc,
        endsAt: slot.end.utc,
        acceptance: {
          usageRulesVersion: 1,
          bookingPolicyVersion: 1,
          nonCancellable,
        },
      },
    },
  );
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

export const newPassword = "Cuenta-vecinal-2026!";

/** Signs in with an email and password (no second factor). */
export async function signInWith(
  page: Page,
  email: string,
  password = newPassword,
) {
  await page.goto("/acceso");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/acceso/);
}

/**
 * «Noelia Varela Souto» → noelia.varela@demo.test. Each scenario uses its
 * own resident and every run starts from a fresh database, so the readable
 * address is unique without a random suffix.
 */
export function residentEmail(name: string) {
  const [first = "vecina", second = "demo"] = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(" ");
  return `${first}.${second}@demo.test`;
}

/** A fresh verified resident, registered through /registro and its mail. */
export async function registerResident(page: Page, name: string) {
  const email = residentEmail(name);
  await page.goto("/registro");
  await page.getByLabel("Nombre", { exact: true }).fill(name);
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(newPassword);
  await page.getByRole("button", { name: "Crear cuenta", exact: true }).click();
  await expect(
    page.getByText("Comprueba tu correo para verificar la cuenta."),
  ).toBeVisible();
  await page.goto(mailUrl(await latestMail(email, "verify-email")));
  await expect(page).toHaveURL(/\/acceso/);
  await signInWith(page, email);
  return email;
}

/**
 * Runs the reservation mail worker against the capture database until `done`
 * holds, then stops it. Returns the command line and what it printed.
 */
export async function runMailWorker(
  origin: string,
  done: () => Promise<boolean>,
) {
  const { databases, mail } = await access();
  const root = path.resolve("..");
  const child = spawn(process.execPath, ["src/email-worker.ts"], {
    cwd: root,
    env: {
      ...process.env,
      WORKER_DATABASE_URL: databases.worker,
      EMAIL_LOCALE: "es",
      AUTH_ORIGIN: origin,
      MAIL_TRANSPORT: "local",
      LOCAL_MAIL_DIR: mail,
      EMAIL_POLL_MS: "200",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    await expect.poll(done, { timeout: 30000 }).toBe(true);
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  return { command: "node src/email-worker.ts", output };
}

/** A step capture with the pointer parked, so no hover state shows. */
export async function shot(
  cu: Capture,
  page: Page,
  slug: string,
  options?: Parameters<Capture["shot"]>[2],
) {
  await page.mouse.move(0, 0);
  return cu.shot(page, slug, options);
}

/** The field around a control (box and label), to outline both. */
export const around = (control: Locator) => control.locator("xpath=..");

/** The alert or status box that carries `text`. */
export const notice = (page: Page, text: string | RegExp) =>
  page
    .getByRole("alert")
    .or(page.getByRole("status"))
    // Success boxes announced separately carry role="none".
    .or(page.locator('[data-lumen][role="none"]'))
    .filter({ hasText: text })
    .first();

/** «20 de noviembre»: how the booking pages name a civil date. */
export const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
