import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import pg from "pg";
import { totp } from "../../test/helpers/auth-client";
import { access, type Capture, expect } from "./capture";

// Shared steps for the municipal staff scenarios: the application's own
// pickers and selects, a second browser for concurrent edits, and fresh
// accounts so that no scenario revokes or changes the seeded staff.

export const valdeira = "00000000-0000-4000-8000-00000000d100";
export const ribasanta = "00000000-0000-4000-8000-00000000d200";
export const units = {
  padel1: "00000000-0000-4000-8000-00000000d111",
  tennis: "00000000-0000-4000-8000-00000000d113",
  court: "00000000-0000-4000-8000-00000000d121",
  sportsCourt: "00000000-0000-4000-8000-00000000d211",
} as const;
export const timeZone = "Europe/Madrid";

/** Civil date (`YYYY-MM-DD`) in the municipality, `days` from now. */
export function localDate(days = 0, from = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(from + days * 86400000));
}
/** Local `HH:mm` of an instant in the municipality. */
export function localTime(at: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

const pools = new Map<string, pg.Pool>();
/** Query the capture database with one of its role pools. */
export async function sql<T extends pg.QueryResultRow>(
  role: "auth" | "domain" | "migration" | "worker",
  text: string,
  values: unknown[] = [],
) {
  let pool = pools.get(role);
  if (!pool) {
    const connectionString = (await access()).databases[role];
    pool = new pg.Pool({ connectionString, max: 2 });
    pools.set(role, pool);
  }
  return (await pool.query<T>(text, values)).rows;
}

/** Account id of a seeded or fresh account. */
export async function accountId(email: string) {
  const [row] = await sql<{ id: string }>(
    "auth",
    'SELECT id FROM auth."user" WHERE email=$1',
    [email],
  );
  if (!row) throw new Error(`Unknown account ${email}`);
  return row.id;
}

/** The second factor proof of every session of `email` is older than five minutes. */
export async function ageMfaProof(email: string) {
  await sql(
    "migration",
    `UPDATE auth.session SET "mfaVerifiedAt" = now() - interval '10 minutes'
      WHERE "userId" = $1 AND "mfaVerifiedAt" IS NOT NULL`,
    [await accountId(email)],
  );
}

export const clientHeader = () => {
  const parts = randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g);
  return { "x-quenda-test-client": `2001:db8:${parts?.join(":")}` };
};

/** A second browser, as another person or another tab would have. */
export async function secondBrowser(
  browser: Browser,
  page: Page,
  shareSession = false,
): Promise<BrowserContext> {
  const options = page.context();
  return browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
    locale: "es-ES",
    timezoneId: timeZone,
    colorScheme: "light",
    reducedMotion: "reduce",
    extraHTTPHeaders: clientHeader(),
    storageState: shareSession ? await options.storageState() : undefined,
  });
}

/**
 * A new client address for the browser of `page`. The public catalogue limits
 * requests per address and minute; a scenario that opens many management
 * pages in a row starts each part from its own address, as separate visits.
 */
export async function freshAddress(page: Page) {
  await page.context().setExtraHTTPHeaders(clientHeader());
}

/** Waits for the next TOTP window when an account signs in twice. */
export async function nextTotpWindow() {
  const wait = 30000 - (Date.now() % 30000) + 500;
  await new Promise((resolve) => setTimeout(resolve, wait));
}

export type Fresh = {
  email: string;
  secret: string;
  id: string;
  name: string;
  /** Session cookie of the registration, verified with the second factor. */
  cookie: string;
  /** TOTP window of the last code used: codes are never replayed. */
  window: number;
};

/** A fresh authentication code for `person`, never one already used. */
export async function freshCode(person: Fresh) {
  if (Math.floor(Date.now() / 30000) <= person.window) await nextTotpWindow();
  person.window = Math.floor(Date.now() / 30000);
  return totp(person.secret);
}
const webOrigin = () =>
  `http://127.0.0.1:${process.env.QUENDA_CAPTURE_WEB_PORT ?? 5175}`;

/** A command against the API as `cookie`, as the browser would send it. */
export async function command(cookie: string, path: string, body: object) {
  const response = await fetch(`${(await access()).apiOrigin}${path}`, {
    method: "POST",
    headers: {
      ...clientHeader(),
      origin: webOrigin(),
      cookie,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** The session cookie a page holds, to send commands on its behalf. */
export async function cookieOf(page: Page) {
  return (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

/**
 * Grants `person` municipal permissions through an invitation from the
 * signed-in administrator on `admin` and its acceptance: the precondition of
 * scenarios that need a manager with a narrower scope than the seeded one.
 */
export async function grantManager(
  admin: Page,
  tenantId: string,
  person: Fresh,
  permissions: { operation: string; unitId: string | null }[],
) {
  const { invitationId } = await command(
    await cookieOf(admin),
    `/api/municipalities/${tenantId}/manager-invitations`,
    {
      accountId: person.id,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions,
    },
  );
  await command(
    person.cookie,
    `/api/municipalities/${tenantId}/manager-invitations/${invitationId}/accept`,
    {},
  );
}
/**
 * A verified account with two-factor authentication, registered through the
 * public API as a person would do it, so scenarios never alter seeded staff.
 */
export async function freshAccount(
  email: string,
  name: string,
): Promise<Fresh> {
  const { apiOrigin, password } = await access();
  const headers = {
    ...clientHeader(),
    origin: webOrigin(),
    "content-type": "application/json",
  };
  let cookie = "";
  const call = async (path: string, body: object) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const name = pair?.split("=")[0];
      cookie = [
        ...cookie
          .split("; ")
          .filter((item) => item && !item.startsWith(`${name}=`)),
        pair,
      ].join("; ");
    }
    if (!response.ok)
      throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const signup = await call("/api/auth/sign-up/email", {
    email,
    password,
    name,
  });
  await sql("auth", 'UPDATE auth."user" SET "emailVerified"=true WHERE id=$1', [
    signup.user.id,
  ]);
  await call("/api/auth/sign-in/email", { email, password });
  const enrollment = await call("/api/auth/two-factor/enable", { password });
  const secret = new URL(enrollment.totpURI).searchParams.get("secret") ?? "";
  const window = Math.floor(Date.now() / 30000);
  await call("/api/auth/two-factor/verify-totp", { code: totp(secret) });
  return { email, secret, id: signup.user.id, name, cookie, window };
}

/** Signs a fresh account in on `page` with password and second factor. */
export async function signInAs(page: Page, person: Fresh) {
  const { password } = await access();
  await page.goto("/acceso");
  await page
    .getByLabel("Correo electrónico", { exact: true })
    .fill(person.email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByLabel("Código de autenticación", { exact: true })
    .fill(await freshCode(person));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/acceso/);
}

/** Opens one of the management sections from the side navigation. */
export async function section(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Gestión municipal" })
    .getByRole("link", { name, exact: true })
    .click();
}

/** Chooses an option of the application's select by its visible label. */
export async function choose(
  page: Page,
  name: string | RegExp,
  option: string | RegExp,
  scope: Page | Locator = page,
) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Chooses the option whose native value is `value`, through the visible control. */
export async function chooseValue(
  page: Page,
  name: string,
  label: string | RegExp,
  value: string,
) {
  const option = page.locator(`select[name="${name}"] option`);
  const present = () =>
    option.evaluateAll(
      (items, value) =>
        items.some((item) => (item as HTMLOptionElement).value === value),
      value,
    );
  // Long lists load by pages: ask for the next one until the value appears.
  const more = page.getByRole("button", { name: "Cargar más", exact: true });
  await expect
    .poll(async () => {
      if (await present()) return true;
      if (await more.isVisible()) await more.click();
      return false;
    })
    .toBe(true);
  const text = await option.evaluateAll(
    (items, value) =>
      (
        items.find((item) => (item as HTMLOptionElement).value === value) as
          | HTMLOptionElement
          | undefined
      )?.text ?? "",
    value,
  );
  await choose(page, label, text);
}

const group = (scope: Page | Locator, label: string | RegExp) =>
  scope.getByRole("group", { name: label, exact: typeof label === "string" });

/** Chooses a civil date on the calendar of the field named `label`. */
export async function pickDate(
  page: Page,
  label: string | RegExp,
  date: string,
  scope: Page | Locator = page,
) {
  const field = group(scope, label);
  await field.getByRole("button").first().click();
  const dialog = page.getByRole("dialog").last();
  const focused = dialog.locator('[data-present] [data-date][tabindex="0"]');
  await expect(focused).toBeFocused();
  const from = (await focused.getAttribute("data-date")) ?? date;
  const [fy = 0, fm = 0] = from.split("-").map(Number);
  const [ty = 0, tm = 0] = date.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  while (months) {
    const forward = months > 0;
    await page.keyboard.press(forward ? "PageDown" : "PageUp");
    months -= forward ? 1 : -1;
  }
  const day = dialog.locator(`[data-present] [data-date="${date}"]`);
  await expect(day).toBeVisible();
  await day.click();
  await expect(field.locator('input[aria-hidden="true"]')).toHaveValue(date);
  await expect(dialog).toBeHidden();
}

/** Chooses the date and types the time of a date-time field. */
export async function pickDateTime(
  page: Page,
  label: string,
  date: string,
  time: string,
  scope: Page | Locator = page,
) {
  await pickDate(page, label, date, scope);
  await scope
    .getByRole("textbox", { name: `${label} · hora`, exact: true })
    .fill(time);
}

/** Chooses a month (`YYYY-MM`) in the month field named `label`. */
export async function pickMonth(page: Page, label: string, month: string) {
  await group(page, label).getByRole("button").first().click();
  const dialog = page.getByRole("dialog").last();
  const target = Number(month.slice(0, 4));
  for (let step = 0; step < 50; step++) {
    const shown = Number(
      (
        await dialog.locator("[data-month]").first().getAttribute("data-month")
      )?.slice(0, 4),
    );
    if (shown === target) break;
    await dialog
      .getByRole("button", {
        name: shown > target ? "Año anterior" : "Año siguiente",
      })
      .click();
  }
  await dialog.locator(`[data-month="${month}"]`).click();
  await expect(
    group(page, label).locator('input[aria-hidden="true"]'),
  ).toHaveValue(month);
  await expect(dialog).toBeHidden();
}

type SnapOptions = Parameters<Capture["shot"]>[2] & {
  /** Grow the window so the whole scrolled content fits in the capture. */
  tall?: boolean;
};
/**
 * A capture once every image (such as the municipal logo) has loaded. The
 * management pages scroll inside their own panel, so `tall` grows the window
 * to show a long form at once instead of relying on a full-page capture.
 */
export async function snap(
  cu: Capture,
  page: Page,
  slug: string,
  { tall, ...options }: SnapOptions = {},
) {
  // The management menu shows the municipal logo once its branding loads.
  const municipality = page.getByRole("link", { name: /Cambiar municipio$/ });
  if (await municipality.count())
    await expect(municipality.locator("img"))
      .toBeVisible({ timeout: 5000 })
      .catch(() => {});
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every((image) => {
          const box = image.getBoundingClientRect();
          const shown =
            box.width > 0 &&
            box.bottom > 0 &&
            box.top < innerHeight &&
            getComputedStyle(image).visibility !== "hidden";
          return (
            !shown || !image.src || (image.complete && image.naturalWidth > 0)
          );
        }),
      ),
    )
    .toBe(true);
  // A focused field draws its own focus ring over the highlight.
  if (options.target)
    await options.target.evaluate((element) => {
      if (element === document.activeElement) (element as HTMLElement).blur();
    });
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  if (tall) {
    const extra = await page.evaluate(() => {
      let overflow = 0;
      for (const element of document.querySelectorAll("*")) {
        const style = getComputedStyle(element);
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1
        ) {
          overflow = Math.max(
            overflow,
            element.scrollHeight - element.clientHeight,
          );
          element.scrollTop = 0;
        }
      }
      return overflow;
    });
    await page.setViewportSize({
      width: size.width,
      height: Math.min(size.height + extra, 3200),
    });
  }
  try {
    return await cu.shot(page, slug, options);
  } finally {
    if (tall) await page.setViewportSize(size);
  }
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );

/**
 * A downloaded spreadsheet as a person sees it when opening it: the file name,
 * lettered columns, numbered rows and cells cut to their column width. Only
 * the first rows are drawn; columns beyond the window stay out of sight.
 */
export async function spreadsheet(
  cu: Capture,
  page: Page,
  slug: string,
  name: string,
  csv: string,
  rows = 5,
) {
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .slice(0, rows + 1)
    .map((line) => line.split(","));
  const letter = (index: number) => String.fromCharCode(65 + index);
  const columns = lines[0]?.length ?? 0;
  const head = `<tr><th></th>${Array.from({ length: columns }, (_, index) => `<th>${letter(index)}</th>`).join("")}</tr>`;
  const body = lines
    .map(
      (cells, row) =>
        `<tr${row === 0 ? ' class="names"' : ""}><th>${row + 1}</th>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  const scratch = await page.context().newPage();
  try {
    await scratch.setViewportSize({ width: 1240, height: 400 });
    await scratch.setContent(`<!doctype html>
<style>
  body { margin: 0; padding: 24px; background: #e9ecef; font: 13px/1.4 system-ui, sans-serif; color: #1f2328; }
  main { width: 1190px; overflow: hidden; border-radius: 10px; background: #fff; box-shadow: 0 8px 24px rgb(0 0 0 / .12); }
  h1 { margin: 0; padding: 10px 16px; font: 600 13px/1.4 system-ui, sans-serif; color: #57606a; background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
  table { border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #d0d7de; padding: 5px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 150px; max-width: 150px; }
  th { background: #f6f8fa; color: #57606a; font-weight: 500; text-align: center; }
  tr th:first-child { width: 36px; max-width: 36px; }
  tr.names td { font-weight: 600; background: #f6f8fa; }
</style>
<main><h1>${escapeHtml(name)}</h1><table>${head}${body}</table></main>`);
    return await cu.shot(scratch, slug, { clip: scratch.locator("main") });
  } finally {
    await scratch.close();
  }
}

/** The form that contains the button named `name`. */
export const formWith = (scope: Page | Locator, name: string | RegExp) =>
  scope
    .locator("form")
    .filter({ has: scope.getByRole("button", { name, exact: true }) });

/** Signs a resident without second factor in, by email. */
export async function signInResident(page: Page, email: string) {
  const { password } = await access();
  await page.goto("/acceso");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/acceso/);
}

/** A free one-hour slot of `unit` some days ahead, from the public catalogue. */
export async function freeSlot(tenant: string, unit: string, days = 2) {
  const { apiOrigin } = await access();
  for (let offset = days; offset < days + 14; offset++) {
    const response = await fetch(
      `${apiOrigin}/api/public/municipalities/${tenant}/units/${unit}/availability?date=${localDate(offset)}&durationMinutes=60`,
      { headers: clientHeader() },
    );
    const { slots } = (await response.json()) as {
      slots: { start: { utc: string }; end: { utc: string } }[];
    };
    const slot = slots.at(-3) ?? slots[0];
    if (slot) return { start: slot.start.utc, end: slot.end.utc };
  }
  throw new Error("No free slot");
}

/** The checkout of one slot, where a resident confirms a reservation. */
export const checkout = (
  tenant: string,
  unit: string,
  slot: { start: string; end: string },
) =>
  `/municipios/${tenant}/unidades/${unit}/reservar?inicio=${encodeURIComponent(slot.start)}&fin=${encodeURIComponent(slot.end)}`;

/**
 * An agreement between Valdeira (on `marta`) and Ribasanta (on `xoan`),
 * created, approved by both and activated through the management screens:
 * the precondition of the accreditation scenario.
 */
export async function activeAgreement(
  marta: Page,
  xoan: Page,
  name: string,
  { accreditation = false } = {},
) {
  await freshAddress(marta);
  await freshAddress(xoan);
  await marta.goto(`/administracion/${valdeira}/convenios/nuevo`);
  await marta.getByLabel("Nombre del convenio", { exact: true }).fill(name);
  await pickDateTime(marta, "Inicio de vigencia", localDate(0), "00:00");
  await pickDateTime(marta, "Fin de vigencia", localDate(120), "23:59");
  for (const [label, text] of [
    [
      "Finalidad",
      "Actividad deportiva adaptada en pistas de ambos municipios.",
    ],
    ["Base jurídica", "Convenio intermunicipal aprobado por ambos plenos."],
    ["Responsabilidades", "Cada municipio gestiona sus instalaciones."],
    ["Conservación acordada", "Un año después del fin de la vigencia."],
  ])
    await marta.getByLabel(label, { exact: true }).fill(text);
  if (accreditation) {
    await choose(marta, "Acceso del convenio", "Acreditación vigente");
    await marta
      .getByRole("checkbox", {
        name: "Emisor de acreditaciones 1",
        exact: true,
      })
      .check();
  }
  await choose(marta, "Añadir unidad municipal", "Pista de tenis");
  await marta
    .getByRole("button", { name: "Añadir unidad", exact: true })
    .click();
  await marta.getByRole("button", { name: "Añadir participante" }).click();
  await marta.getByLabel("Municipio 2", { exact: true }).fill(ribasanta);
  await marta
    .getByLabel("Unidades: un identificador por línea · 2", { exact: true })
    .fill(units.sportsCourt);
  await marta
    .getByRole("checkbox", { name: "Confirmo la configuración del borrador" })
    .check();
  await marta
    .getByRole("button", { name: "Crear borrador", exact: true })
    .click();
  await expect(marta).toHaveURL(/\/convenios\/[\da-f-]+\/versiones\/1$/);
  const path = new URL(marta.url()).pathname;
  const agreementId = path.split("/convenios/")[1]?.split("/")[0] ?? "";
  for (const [page, tenant] of [
    [marta, valdeira],
    [xoan, ribasanta],
  ] as const) {
    await page.goto(
      `/administracion/${tenant}/convenios/${agreementId}/versiones/1`,
    );
    await page
      .getByRole("checkbox", { name: "Confirmo esta versión y mis unidades" })
      .check();
    await page
      .getByRole("button", { name: "Aprobar versión", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Aprobar versión" }),
    ).toHaveCount(0);
  }
  await marta.goto(path);
  await marta
    .getByLabel("Referencia de revisión jurídica", { exact: true })
    .fill("Informe de Secretaría 2026/120");
  await marta
    .getByRole("checkbox", { name: "Confirmo la activación de esta versión" })
    .check();
  await marta
    .getByRole("button", { name: "Activar versión", exact: true })
    .click();
  await expect(marta.getByText("ACTIVADO", { exact: true })).toBeVisible();
  await freshAddress(marta);
  await freshAddress(xoan);
  return { agreementId, path };
}

/**
 * Suspends the agreement from Ribasanta and withdraws both restrictive
 * bindings, so that later scenarios find both courts open as seeded.
 */
export async function closeAgreement(
  marta: Page,
  xoan: Page,
  agreementId: string,
) {
  await freshAddress(marta);
  await freshAddress(xoan);
  await xoan.goto(
    `/administracion/${ribasanta}/convenios/${agreementId}/versiones/1`,
  );
  await xoan.getByLabel("Motivo", { exact: true }).fill("Fin del programa");
  await xoan
    .getByRole("checkbox", { name: "Confirmo la suspensión del convenio" })
    .check();
  await xoan
    .getByRole("button", { name: "Suspender convenio", exact: true })
    .click();
  await expect(xoan.getByText("SUSPENDIDO", { exact: true })).toBeVisible();
  for (const [page, tenant, unit] of [
    [xoan, ribasanta, units.sportsCourt],
    [marta, valdeira, units.tennis],
  ] as const) {
    await page.goto(
      `/administracion/${tenant}/convenios/unidades/${unit}/reapertura`,
    );
    await page
      .getByLabel("Motivo", { exact: true })
      .fill("Reapertura municipal");
    await page
      .getByRole("checkbox", {
        name: "Confirmo la retirada de esta vinculación",
      })
      .check();
    await page
      .getByRole("button", { name: "Retirar vinculación", exact: true })
      .click();
    await expect(
      page.getByText("Sin vinculación restrictiva registrada.", {
        exact: true,
      }),
    ).toBeVisible();
  }
}
