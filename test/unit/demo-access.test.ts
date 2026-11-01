import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import {
  currentDemoCode,
  type DemoAccess,
  demoAdministrator,
  demoApiOrigin,
  demoRunIdentity,
  demoWebOrigin,
  parseDemoAccess,
  readDemoAccess,
  registerDemoRun,
  writeDemoAccess,
} from "../demo/access-state.ts";
import { totp } from "../helpers/auth-client.ts";

// RFC test fixture only, never deployed as a demo credential.
const access: DemoAccess = {
  version: 1,
  runId: "11111111-1111-4111-8111-111111111111",
  processId: 42,
  startedAt: "2026-10-24T10:00:00.000Z",
  apiOrigin: demoApiOrigin,
  webOrigin: demoWebOrigin,
  administrator: demoAdministrator,
  administratorSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};

test("demo TOTP uses one instant at interval boundaries (RFC 6238 fixture)", () => {
  assert.equal(totp(access.administratorSecret, 0, 59_000), "287082");
  assert.equal(totp(access.administratorSecret, 0, 59_999), "287082");
  assert.equal(totp(access.administratorSecret, 0, 60_000), "359152");
});

test("demo metadata accepts only the fixed local demo and valid run identity", () => {
  assert.deepEqual(parseDemoAccess(access), access);
  for (const invalid of [
    null,
    {},
    { ...access, version: 2 },
    { ...access, apiOrigin: "https://external.test" },
    { ...access, webOrigin: "http://127.0.0.1:5173" },
    { ...access, administrator: "another@example.test" },
    { ...access, processId: 0 },
    { ...access, runId: "old-log" },
    { ...access, startedAt: "yesterday" },
    { ...access, administratorSecret: "invalid" },
  ]) {
    assert.throws(
      () => parseDemoAccess(invalid),
      /Invalid demo access metadata/,
    );
  }
  assert.deepEqual(Object.keys(demoRunIdentity(access)).sort(), [
    "processId",
    "runId",
    "startedAt",
  ]);
});

test("demo access is private, atomically replaceable, and rejects unsafe files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-demo-access-"));
  const directory = path.join(root, "demo");
  const filename = path.join(directory, "access.json");
  try {
    await writeDemoAccess(directory, access);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(await readDemoAccess(directory), access);
    const replacement = {
      ...access,
      runId: "22222222-2222-4222-8222-222222222222",
    };
    await writeDemoAccess(directory, replacement);
    assert.deepEqual(await readDemoAccess(directory), replacement);
    await chmod(filename, 0o644);
    await assert.rejects(readDemoAccess(directory), /mode 0600/);
    await chmod(filename, 0o600);
    await chmod(directory, 0o755);
    await assert.rejects(readDemoAccess(directory), /mode 0700/);
    await assert.rejects(writeDemoAccess(directory, access), /mode 0700/);
    await chmod(directory, 0o700);
    const contents = await readFile(filename, "utf8");
    await rm(filename);
    const target = path.join(root, "target.json");
    await writeFile(target, contents, { mode: 0o600 });
    await symlink(target, filename);
    await assert.rejects(readDemoAccess(directory), /mode 0600/);
    await rm(filename);
    await writeFile(filename, "malformed-json", { mode: 0o600 });
    await assert.rejects(readDemoAccess(directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a code is issued only after checking the exact live run without redirects", async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, `${demoApiOrigin}/__demo/run`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return Response.json(demoRunIdentity(access));
  };
  const result = await currentDemoCode(access, request);
  assert.match(result.code, /^\d{6}$/);
  assert.ok(result.remainingSeconds >= 1 && result.remainingSeconds <= 30);
});

test("stale identity, failed HTTP, malformed response and stopped API never issue codes", async () => {
  for (const identity of [
    null,
    {},
    { ...demoRunIdentity(access), runId: "different" },
    { ...demoRunIdentity(access), processId: 43 },
    { ...demoRunIdentity(access), startedAt: "2026-10-24T11:00:00.000Z" },
  ]) {
    await assert.rejects(
      currentDemoCode(access, async () => Response.json(identity)),
      /different launch/,
    );
  }
  await assert.rejects(
    currentDemoCode(
      access,
      async () => new Response("missing", { status: 404 }),
    ),
    /cannot confirm/,
  );
  await assert.rejects(
    currentDemoCode(access, async () => new Response("invalid-json")),
  );
  await assert.rejects(
    currentDemoCode(access, async () => {
      throw new Error("connection refused");
    }),
    /connection refused/,
  );
});

test("demo identity is registered before seed injection boots Fastify and never exposes secrets", async () => {
  const app = await buildApp({
    database: { check: async () => {}, close: async () => {} },
    logLevel: "silent",
  });
  try {
    registerDemoRun(app, demoRunIdentity(access));
    // Seed requests call inject() before listen(); registering afterwards fails.
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    const response = await app.inject("/__demo/run");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), demoRunIdentity(access));
    assert.ok(!response.body.includes(access.administratorSecret));
  } finally {
    await app.close();
  }
});
