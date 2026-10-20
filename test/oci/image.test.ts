import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.env.QUENDA_IMAGE ?? "quenda-backend:local";
const run = (...args: string[]) =>
  execute(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      image,
      ...args,
    ],
    { timeout: 30000 },
  );

test("OCI runtime contains production artifacts and runs without root or writable filesystem", async () => {
  const result = await run(
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { existsSync, readdirSync } from 'node:fs';
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.NODE_ENV, 'production');
    assert.equal(process.version, 'v24.21.0');
    assert.deepEqual(readdirSync('/app').sort(), ['LICENSE','db','dist','node_modules','package.json','scripts']);
    assert.equal(existsSync('/app/node_modules/typescript'), false);
    assert.equal(existsSync('/app/node_modules/@biomejs/biome'), false);
    for (const file of ['dist/server.js','dist/email-worker.js','dist/monthly-report-worker.js','scripts/migrate.ts']) assert.ok(existsSync(file));
    const { buildApp } = await import('./dist/app.js');
    const app = await buildApp({ database: { check: async () => {}, close: async () => {} }, logLevel: 'silent' });
    await app.ready();
    assert.equal((await app.inject({ url: '/health/live' })).statusCode, 200);
    await app.close();
    console.log('OCI runtime verified');
  `,
  );
  assert.match(result.stdout, /OCI runtime verified/);
});

test("API, mail worker and migrator reject missing configuration in the same image", async () => {
  for (const entry of [
    "dist/server.js",
    "dist/email-worker.js",
    "scripts/migrate.ts",
  ]) {
    await assert.rejects(run(entry), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.ok(failure.stderr.length > 0);
      assert.ok(!failure.stderr.includes("postgresql://"));
      return true;
    });
  }
});
