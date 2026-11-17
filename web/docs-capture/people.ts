import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  request,
  test,
} from "@playwright/test";
import pg from "pg";
import { totp } from "../../test/helpers/auth-client";
import {
  access,
  account,
  type Capture,
  latestMail,
  mailUrl,
  roles,
} from "./capture";

// Accounts, sessions and back-office commands for the platform and privacy
// scenarios. Destructive scenarios act on accounts and municipalities created
// here, never on the seeded people other scenarios rely on.

const root = path.resolve("..");
const run = promisify(execFile);

/** Last TOTP step used per secret: a code is never presented twice. */
const used = new Map<string, number>();
export async function code(secret: string) {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30000);
    const left = 30000 - (now % 30000);
    if (used.get(secret) !== step && left > 3000) {
      used.set(secret, step);
      return totp(secret);
    }
    await new Promise((resolve) => setTimeout(resolve, left + 250));
  }
}

const baseURL = () => test.info().project.use.baseURL as string;
const address = () =>
  `2001:db8:${randomUUID()
    .replaceAll("-", "")
    .slice(0, 24)
    .match(/.{4}/g)
    ?.join(":")}`;

export type Person = {
  name: string;
  email: string;
  accountId: string;
  secret: string | null;
  password: string;
  api: APIRequestContext;
};

/** A separate client, as another person's browser would be. */
export async function client() {
  return request.newContext({
    baseURL: baseURL(),
    extraHTTPHeaders: { Origin: baseURL(), "x-quenda-test-client": address() },
  });
}

/** Another person's browser, with the same desktop, language and theme. */
export async function otherBrowser(browser: Browser) {
  const use = test.info().project.use;
  return browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    locale: use.locale,
    timezoneId: use.timezoneId,
    colorScheme: use.colorScheme,
    reducedMotion: use.reducedMotion,
    userAgent: use.userAgent,
    extraHTTPHeaders: { "x-quenda-test-client": address() },
  });
}

async function ok(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return response;
}
/** The body of a successful response. */
async function read<T>(
  response: Awaited<ReturnType<APIRequestContext["post"]>>,
) {
  return (await (await ok(response)).json()) as T;
}

export async function apiSignIn(person: Omit<Person, "api" | "name">) {
  const api = await client();
  const response = await read<{ twoFactorRedirect?: boolean }>(
    await api.post("/api/auth/sign-in/email", {
      data: { email: person.email, password: person.password },
    }),
  );
  if (person.secret) {
    expect(response.twoFactorRedirect).toBe(true);
    for (let attempt = 0; ; attempt++) {
      const verified = await api.post("/api/auth/two-factor/verify-totp", {
        data: { code: await code(person.secret) },
      });
      if (verified.ok()) break;
      if (attempt === 2) await ok(verified);
    }
  }
  return api;
}

/** Registers, verifies the address from the mail sink and, if asked, enrols TOTP. */
export async function register(
  name: string,
  email: string,
  { mfa }: { mfa: boolean },
): Promise<Person> {
  const { password } = await access();
  const api = await client();
  const created = await read<{ user: { id: string } }>(
    await api.post("/api/auth/sign-up/email", {
      data: { email, password, name },
    }),
  );
  const accountId = created.user.id;
  const verify = new URL(mailUrl(await latestMail(email, "verify-email")));
  await api.get(`${verify.pathname}${verify.search}`, { maxRedirects: 0 });
  let secret: string | null = null;
  const session = await apiSignIn({ email, accountId, secret, password });
  if (mfa) {
    const enabled = await read<{ totpURI: string }>(
      await session.post("/api/auth/two-factor/enable", { data: { password } }),
    );
    secret = new URL(enabled.totpURI).searchParams.get("secret");
    if (!secret) throw new Error("Missing TOTP secret");
    await ok(
      await session.post("/api/auth/two-factor/verify-totp", {
        data: { code: await code(secret) },
      }),
    );
  }
  await api.dispose();
  // The session that enrolled TOTP has just verified the second factor.
  return { name, email, accountId, secret, password, api: session };
}

/** Browser sign-in with password and, when enrolled, a fresh TOTP code. */
export async function signInAs(
  page: Page,
  person: { email: string; secret: string | null; password?: string },
) {
  const password = person.password ?? (await access()).password;
  await page.goto("/acceso");
  await page
    .getByLabel("Correo electrónico", { exact: true })
    .fill(person.email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  if (person.secret) {
    const field = page.getByLabel("Código de autenticación", { exact: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      await field.fill(await code(person.secret));
      await page
        .getByRole("button", { name: "Verificar", exact: true })
        .click();
      const left = await expect(page)
        .not.toHaveURL(/\/acceso/, { timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (left) break;
    }
  }
  await expect(page).not.toHaveURL(/\/acceso/);
}

/** A seeded role (operator, administrators) signed in through the browser. */
export async function signInRole(page: Page, role: keyof typeof roles) {
  const { email, secret } = await account(roles[role]);
  await signInAs(page, { email, secret });
  return email;
}

export async function seeded(role: keyof typeof roles) {
  const { email, secret } = await account(roles[role]);
  const { password } = await access();
  const accountId = await idOf(email);
  return { email, secret, password, accountId };
}

let pool: pg.Pool | undefined;
/** Maintenance connection to the same database, for state the UI cannot reach. */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  pool ??= new pg.Pool({
    connectionString: (await access()).databases.migration,
    max: 2,
  });
  return (await pool.query<T>(text, values)).rows;
}
export async function closeSql() {
  await pool?.end();
  pool = undefined;
}
export async function idOf(email: string) {
  const [row] = await sql<{ id: string }>(
    'SELECT id FROM auth."user" WHERE email=$1',
    [email],
  );
  if (!row) throw new Error(`No account ${email}`);
  return row.id;
}

/** Ages the recent second-factor check of every session of the account. */
export async function expireMfa(accountId: string) {
  await sql(
    `UPDATE auth.session SET "mfaVerifiedAt"=now()-interval '10 minutes' WHERE "userId"=$1`,
    [accountId],
  );
}

export type Command = { shown: string; output: string; code: number };
/**
 * Runs a repository command for real and returns what an operator would see,
 * with connection strings and paths replaced by placeholders.
 */
export async function command(
  args: string[],
  env: Record<string, string>,
  shown: string,
  redact: Record<string, string> = {},
  file = process.execPath,
  json = false,
): Promise<Command> {
  const result = await run(file, args, {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 120000,
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: typeof error.code === "number" ? error.code : 1,
    }),
  );
  // `… | jq .`: the same document, indented for reading.
  if (json && result.stdout.trim())
    result.stdout = execFileSync("jq", ["."], {
      input: result.stdout,
      encoding: "utf8",
    });
  let output = `${result.stdout}${result.stderr}`.trimEnd();
  if (result.code) output += `\n(código de salida ${result.code})`;
  const replacements = {
    ...Object.fromEntries(
      Object.entries(env).map(([name, value]) => [value, `$${name}`]),
    ),
    ...redact,
  };
  for (const [value, placeholder] of Object.entries(replacements).sort(
    (a, b) => b[0].length - a[0].length,
  ))
    if (value.length > 3) output = output.replaceAll(value, placeholder);
  output = output.replace(/postgres(?:ql)?:\/\/\S+/g, "$DATABASE_URL");
  return { shown, output, code: result.code };
}

/**
 * A municipality of its own for privacy scenarios: the operator registers it,
 * its administrator accepts, and a member of staff accepts explicit privacy
 * permissions (consultation and execution) for the whole municipality.
 */
export async function privacyMunicipality(
  name: string,
  administrator: [string, string],
  staff: [string, string],
) {
  const operatorApi = await apiSignIn(await seeded("operator"));
  const admin = await register(...administrator, { mfa: true });
  const privacy = await register(...staff, { mfa: true });
  const { tenantId, invitationId } = await read<{
    tenantId: string;
    invitationId: string;
  }>(
    await operatorApi.post("/api/municipalities", {
      data: {
        name,
        timezone: "Europe/Madrid",
        administratorId: admin.accountId,
        invitationExpiresAt: future(3).toISOString(),
      },
    }),
  );
  await operatorApi.dispose();
  await ok(
    await admin.api.post(
      `/api/municipalities/${tenantId}/administrator-invitations/${invitationId}/accept`,
      { data: {} },
    ),
  );
  const invited = await read<{ invitationId: string }>(
    await admin.api.post(
      `/api/municipalities/${tenantId}/manager-invitations`,
      {
        data: {
          accountId: privacy.accountId,
          expiresAt: future(3).toISOString(),
          permissions: [
            { operation: "PRIVACY_READ", unitId: null },
            { operation: "PRIVACY_EXECUTE", unitId: null },
          ],
        },
      },
    ),
  );
  await ok(
    await privacy.api.post(
      `/api/municipalities/${tenantId}/manager-invitations/${invited.invitationId}/accept`,
      { data: {} },
    ),
  );
  return { tenantId, admin, privacy };
}

/** A resident's service relation with the municipality, dated `days` ago. */
export async function profile(
  tenantId: string,
  accountId: string,
  days: number,
) {
  await sql(
    `INSERT INTO domain.municipal_profile(tenant_id,account_id,created_at)
     VALUES($1,$2,now()-make_interval(days=>$3))`,
    [tenantId, accountId, days],
  );
}

/**
 * Brings a form's submit button to the middle of the window, so a message
 * shown just above it and the button itself are both fully in the capture.
 */
export async function alongside(button: Locator) {
  await button.evaluate((node) => {
    // Scroll only the panel that holds the form, leaving the page frame still.
    let box = node.parentElement;
    while (
      box &&
      !(
        /(auto|scroll)/.test(getComputedStyle(box).overflowY) &&
        box.scrollHeight > box.clientHeight
      )
    )
      box = box.parentElement;
    const bottom = box ? box.getBoundingClientRect().bottom : innerHeight;
    const overflow = node.getBoundingClientRect().bottom - bottom + 48;
    if (box) {
      if (overflow > 0) box.scrollTop += overflow;
      document.scrollingElement?.scrollTo(0, 0);
    } else if (overflow > 0) scrollBy(0, overflow);
  });
}

export function future(days: number) {
  return new Date(Date.now() + days * 86400000);
}

/**
 * Captures a page whose content is taller than the window: the window grows to
 * the height of its scrolling area for this one capture, then returns to 800.
 */
export async function tallShot(
  cu: Capture,
  page: Page,
  slug: string,
  options: Parameters<Capture["shot"]>[2] = {},
) {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const extra = await page.evaluate(() => {
    let most = document.documentElement.scrollHeight - innerHeight;
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      most = Math.max(most, element.scrollHeight - element.clientHeight);
    }
    return Math.max(0, most);
  });
  await page.setViewportSize({
    width: size.width,
    height: Math.min(size.height + extra, 2600),
  });
  try {
    await page.evaluate(() => scrollTo(0, 0));
    return await cu.shot(page, slug, options);
  } finally {
    await page.setViewportSize(size);
  }
}
