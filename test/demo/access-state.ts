import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { totp } from "../helpers/auth-client.ts";

export const demoApiOrigin = "http://127.0.0.1:3100";
export const demoWebOrigin = "http://127.0.0.1:5174";
export const demoAdministrator = "administracion@valdeira.demo.test";

export interface DemoAccess {
  version: 1;
  runId: string;
  processId: number;
  startedAt: string;
  apiOrigin: typeof demoApiOrigin;
  webOrigin: typeof demoWebOrigin;
  administrator: typeof demoAdministrator;
  administratorSecret: string;
}

/** Demo credentials must never be inferred from an earlier launch's log. */
export function parseDemoAccess(value: unknown): DemoAccess {
  if (!value || typeof value !== "object")
    throw new Error("Invalid demo access metadata");
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      item.runId,
    ) ||
    !Number.isSafeInteger(item.processId) ||
    Number(item.processId) <= 0 ||
    typeof item.startedAt !== "string" ||
    !Number.isFinite(Date.parse(item.startedAt)) ||
    item.apiOrigin !== demoApiOrigin ||
    item.webOrigin !== demoWebOrigin ||
    item.administrator !== demoAdministrator ||
    typeof item.administratorSecret !== "string" ||
    !/^[A-Z2-7]{16,128}$/.test(item.administratorSecret)
  )
    throw new Error("Invalid demo access metadata");
  return item as unknown as DemoAccess;
}

async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "Demo access directory must be owned by this user with mode 0700",
    );
}

/** Atomic 0600 publication occurs only after this run has bound the API port. */
export async function writeDemoAccess(directory: string, value: DemoAccess) {
  const access = parseDemoAccess(value);
  await privateDirectory(directory, true);
  const temporary = path.join(directory, `.access-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(access));
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, "access.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readDemoAccess(directory: string): Promise<DemoAccess> {
  await privateDirectory(directory);
  const filename = path.join(directory, "access.json");
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "Demo access file must be owned by this user with mode 0600",
    );
  return parseDemoAccess(JSON.parse(await readFile(filename, "utf8")));
}

export function demoRunIdentity(access: DemoAccess) {
  return {
    runId: access.runId,
    processId: access.processId,
    startedAt: access.startedAt,
  };
}

export function registerDemoRun(
  app: FastifyInstance,
  identity: ReturnType<typeof demoRunIdentity>,
) {
  // Register before the first seed request calls app.inject() and boots Fastify.
  // The socket is bound only after seeding succeeds. No secret is exposed here.
  app.get("/__demo/run", async (_request, reply) =>
    reply.header("cache-control", "no-store").send(identity),
  );
}

/** Probe only the fixed loopback demo endpoint. Never use a URL supplied by metadata. */
export async function currentDemoCode(
  access: DemoAccess,
  request: typeof fetch = fetch,
) {
  parseDemoAccess(access);
  const response = await request(`${demoApiOrigin}/__demo/run`, {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      "The demo cannot confirm its current run; do not use a code from an old log",
    );
  const current: unknown = await response.json();
  if (
    !current ||
    typeof current !== "object" ||
    Object.entries(demoRunIdentity(access)).some(
      ([key, value]) => (current as Record<string, unknown>)[key] !== value,
    )
  )
    throw new Error(
      "Demo access metadata belongs to a different launch; no code was generated",
    );
  const now = Date.now();
  return {
    code: totp(access.administratorSecret, 0, now),
    remainingSeconds: 30 - (Math.floor(now / 1000) % 30),
  };
}
