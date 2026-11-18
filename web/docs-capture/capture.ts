import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import sharp from "sharp";
import { totp } from "../../test/helpers/auth-client";

const root = path.resolve("..");
const output = path.join(root, "docs/capturas");

type Account = { role: string; email: string; totp: string | null };
type Access = {
  password: string;
  mail: string;
  apiOrigin: string;
  accounts: Account[];
  databases: Record<string, string>;
};

let cached: Access | undefined;
export async function access(): Promise<Access> {
  cached ??= JSON.parse(
    await readFile(path.join(root, ".local/capture/access.json"), "utf8"),
  ) as Access;
  return cached;
}

/** Seeded account by its role label in the cloud demo access file. */
export async function account(role: string) {
  const found = (await access()).accounts.find((item) => item.role === role);
  if (!found) throw new Error(`No seeded account for ${role}`);
  const secret = found.totp
    ? new URL(found.totp).searchParams.get("secret")
    : null;
  return { email: found.email, secret };
}

export const roles = {
  operator: "Operación de la plataforma",
  administrator: "Administración de Valdeira",
  manager: "Gestión de reservas de Valdeira",
  partner: "Administración de Ribasanta",
  citizen: "Vecina (reserva habitual)",
} as const;

// Each scenario is its own client so the real per-address limits stay on.
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  extraHTTPHeaders: async ({}, use) => {
    const parts = randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g);
    await use({ "x-quenda-test-client": `2001:db8:${parts?.join(":")}` });
  },
});
export { expect };

// Close to the element so that the box never covers a neighbouring label.
const highlightStyle = {
  outline: "3px solid #d9480f",
  outlineOffset: "2px",
  borderRadius: "6px",
  boxShadow: "0 0 0 5px rgb(217 72 15 / 0.18)",
};

type ShotOptions = {
  /** Element the reader acts on in this step; outlined in the capture. */
  target?: Locator;
  /** Capture only this region instead of the viewport. */
  clip?: Locator;
  fullPage?: boolean;
};

/**
 * Ordered captures for one use case: `docs/capturas/cu-XX/NN-slug.webp`.
 * The folder is emptied on the first capture so removed steps do not linger.
 */
export class Capture {
  private count = 0;
  private ready: Promise<void> | undefined;
  readonly directory: string;
  constructor(readonly useCase: string) {
    this.directory = path.join(output, useCase.toLowerCase());
  }
  private prepare() {
    this.ready ??= rm(this.directory, { recursive: true, force: true }).then(
      () => mkdir(this.directory, { recursive: true }).then(() => undefined),
    );
    return this.ready;
  }
  private async store(png: Buffer, slug: string) {
    await this.prepare();
    this.count += 1;
    const name = `${String(this.count).padStart(2, "0")}-${slug}.webp`;
    await sharp(png)
      .webp({ quality: 80, effort: 6 })
      .toFile(path.join(this.directory, name));
    return name;
  }

  async shot(page: Page, slug: string, options: ShotOptions = {}) {
    await settle(page);
    const { target } = options;
    if (target) {
      await target.scrollIntoViewIfNeeded();
      // A sticky header or a floating bar may still cover part of the
      // element: bring it to the middle of its scroll area instead.
      const moved = await target.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + Math.min(box.width / 2, 40);
        const free = (y: number) => {
          if (y < 0 || y >= innerHeight) return true;
          const hit = document.elementFromPoint(x, y);
          return !hit || element.contains(hit) || hit.contains(element);
        };
        if (free(box.top + 2) && free(box.bottom - 2)) return false;
        element.scrollIntoView({ block: "center", inline: "nearest" });
        return true;
      });
      if (moved) await settle(page);
      await target.evaluate((element, style) => {
        const node = element as HTMLElement;
        node.dataset.captureStyle = node.getAttribute("style") ?? "";
        Object.assign(node.style, style);
      }, highlightStyle);
    }
    try {
      const png = options.clip
        ? await options.clip.screenshot({ animations: "disabled" })
        : await page.screenshot({
            animations: "disabled",
            fullPage: options.fullPage ?? false,
            caret: "initial",
          });
      return await this.store(png, slug);
    } finally {
      if (target)
        await target
          .evaluate((element) => {
            const node = element as HTMLElement;
            const previous = node.dataset.captureStyle;
            if (previous) node.setAttribute("style", previous);
            else node.removeAttribute("style");
            delete node.dataset.captureStyle;
          })
          .catch(() => {});
    }
  }

  /** A command and its real output, drawn as a terminal window. */
  async terminal(page: Page, slug: string, command: string, result: string) {
    const scratch = await page.context().newPage();
    try {
      await scratch.setViewportSize({ width: 1000, height: 200 });
      await scratch.setContent(terminalHtml(command, result));
      const png = await scratch
        .locator(".window")
        .screenshot({ animations: "disabled" });
      return await this.store(png, slug);
    } finally {
      await scratch.close();
    }
  }

  /**
   * A message from the local mail sink, drawn as a mail reader. Links show
   * the documentation origin with shortened tokens, never the capture host.
   */
  async mail(page: Page, slug: string, message: Mail) {
    const scratch = await page.context().newPage();
    try {
      await scratch.setViewportSize({ width: 900, height: 200 });
      await scratch.setContent(
        mailHtml({ ...message, text: message.text.replace(urls, displayUrl) }),
      );
      const png = await scratch
        .locator(".message")
        .screenshot({ animations: "disabled" });
      return await this.store(png, slug);
    } finally {
      await scratch.close();
    }
  }

  /** A file a person receives (an export, a download), drawn as a viewer. */
  async file(page: Page, slug: string, name: string, content: string) {
    const scratch = await page.context().newPage();
    try {
      await scratch.setViewportSize({ width: 1000, height: 200 });
      await scratch.setContent(fileHtml(name, content));
      const png = await scratch
        .locator(".viewer")
        .screenshot({ animations: "disabled" });
      return await this.store(png, slug);
    } finally {
      await scratch.close();
    }
  }
}

/** Origin printed in place of the local capture host. */
export const displayOrigin = "https://quenda.example.org";
const urls = /https?:\/\/127\.0\.0\.1:\d+[^\s]*/g;
/** Same path, single-use tokens and identifiers shortened, callback dropped. */
export function displayUrl(raw: string) {
  const url = new URL(raw);
  const shorten = (value: string) =>
    value.length > 20 ? `${value.slice(0, 8)}…` : value;
  const path = url.pathname.split("/").map(shorten).join("/");
  const query = [...url.searchParams]
    .filter(([key]) => key !== "callbackURL")
    .map(([key, value]) => `${key}=${shorten(value)}`);
  return `${displayOrigin}${path}${query.length ? `?${query.join("&")}` : ""}`;
}

/** Waits for pending requests, loading placeholders, fonts and transitions. */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Sections load on their own: wait until no «Cargando…» placeholder shows.
  await expect(
    page.locator('[role="status"]').filter({ hasText: /^Cargando conten/ }),
  )
    .toHaveCount(0, { timeout: 10000 })
    .catch(() => {});
  // Routes load lazily: wait until the page has its heading, then for the
  // requests that heading's view started.
  await page
    .locator("main h1")
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  // Script-driven transitions (fades, highlights sweeping across a message)
  // run outside the animation list: give them time to end.
  await page.waitForTimeout(450);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export async function signIn(page: Page, role: keyof typeof roles) {
  const { email, secret } = await account(roles[role]);
  const { password } = await access();
  await page.goto("/acceso");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel(/^Contraseña$/).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  if (secret) {
    await page
      .getByLabel("Código de autenticación", { exact: true })
      .fill(totp(secret));
    await page.getByRole("button", { name: "Verificar", exact: true }).click();
  }
  await expect(page).not.toHaveURL(/\/acceso/);
  return email;
}

export type Mail = { to: string; subject: string; text: string; html?: string };

/** Newest message to `to` whose text contains `includes`. */
export async function latestMail(to: string, includes = "") {
  const { mail } = await access();
  let found: Mail | undefined;
  await expect
    .poll(async () => {
      const files = await readdir(mail).catch(() => [] as string[]);
      const dated = await Promise.all(
        files.map(async (file) => ({
          file,
          time: (await stat(path.join(mail, file))).mtimeMs,
        })),
      );
      for (const { file } of dated.sort((a, b) => b.time - a.time)) {
        const message = JSON.parse(
          await readFile(path.join(mail, file), "utf8"),
        ) as Mail;
        if (message.to === to && message.text.includes(includes)) {
          found = message;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found as Mail;
}

/** Last URL in a mail body: verification, reset and change links. */
export const mailUrl = (message: Mail) =>
  message.text.match(/https?:\/\/\S+/g)?.at(-1) ?? "";

const html = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );

const terminalHtml = (command: string, result: string) => `<!doctype html>
<style>
  body { margin: 0; padding: 24px; background: #e9ecef; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .window { width: 920px; border-radius: 10px; overflow: hidden; background: #1e1f22; color: #e6e6e6; box-shadow: 0 8px 24px rgb(0 0 0 / .25); }
  .bar { display: flex; gap: 8px; padding: 10px 14px; background: #2b2d31; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  pre { margin: 0; padding: 16px 20px 20px; white-space: pre-wrap; word-break: break-word; }
  .prompt { color: #7ee787; }
</style>
<div class="window"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
<pre><span class="prompt">$</span> ${html(command)}
${html(result.trimEnd())}</pre></div>`;

const mailHtml = (message: Mail) => `<!doctype html>
<style>
  body { margin: 0; padding: 24px; background: #e9ecef; font: 15px/1.55 system-ui, sans-serif; color: #1f2328; }
  .message { width: 820px; background: #fff; border-radius: 10px; box-shadow: 0 8px 24px rgb(0 0 0 / .12); overflow: hidden; }
  header { padding: 16px 22px; border-bottom: 1px solid #d0d7de; background: #f6f8fa; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; color: #57606a; font-size: 13px; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  .body { padding: 18px 22px 22px; white-space: pre-wrap; word-break: break-word; }
</style>
<div class="message"><header><h1>${html(message.subject)}</h1><dl><dt>Para</dt><dd>${html(message.to)}</dd></dl></header>
<div class="body">${html(message.text)}</div></div>`;

const fileHtml = (name: string, content: string) => `<!doctype html>
<style>
  body { margin: 0; padding: 24px; background: #e9ecef; }
  .viewer { width: 920px; border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 8px 24px rgb(0 0 0 / .12); }
  .name { padding: 10px 16px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; font: 600 13px/1.4 system-ui, sans-serif; color: #57606a; }
  pre { margin: 0; padding: 16px 20px 20px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #1f2328; white-space: pre-wrap; word-break: break-word; }
</style>
<div class="viewer"><div class="name">${html(name)}</div><pre>${html(content.trimEnd())}</pre></div>`;
