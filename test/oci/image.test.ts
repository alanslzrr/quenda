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
    assert.deepEqual(readdirSync('/app').sort(), ['LICENSE','db','dist','node_modules','package.json','scripts','source']);
    assert.equal(existsSync('/app/node_modules/typescript'), false);
    assert.equal(existsSync('/app/node_modules/@biomejs/biome'), false);
    for (const file of ['dist/server.js','dist/email-worker.js','dist/monthly-report-worker.js','scripts/migrate.ts']) assert.ok(existsSync(file));
    const { loadSourceOffer } = await import('./dist/http/source-offer.js');
    const offer = await loadSourceOffer(process.env);
    assert.ok(offer);
    const { buildApp } = await import('./dist/app.js');
    const app = await buildApp({ sourceOffer: offer, database: { check: async () => {}, close: async () => {} }, logLevel: 'silent' });
    await app.ready();
    assert.equal((await app.inject({ url: '/health/live' })).statusCode, 200);
    const source = await app.inject({ url: '/legal/source' });
    assert.equal(source.statusCode, 200);
    assert.deepEqual(source.rawPayload, offer.bytes);
    assert.equal(source.headers['x-source-revision'], process.env.SOURCE_REVISION);
    assert.equal(source.headers['x-source-sha256'], process.env.SOURCE_ARCHIVE_SHA256);
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

test("OCI retains base-system copyright notices and the pinned Node license bundle", async () => {
  const result = await run(
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { readFileSync, readdirSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const packages = execFileSync('dpkg-query', ['-W', '-f=\${binary:Package}\\n'], {encoding:'utf8'}).trim().split('\\n');
    assert.ok(packages.length > 0);
    for (const name of packages) {
      assert.ok(readFileSync('/usr/share/doc/' + name.split(':')[0] + '/copyright').length > 0, name);
    }
    const nodeLicense = readFileSync('/usr/local/LICENSE');
    assert.equal(createHash('sha256').update(nodeLicense).digest('hex'), '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace');
    for (const file of ['/usr/local/lib/node_modules/npm/LICENSE', '/usr/local/lib/node_modules/corepack/LICENSE.md', '/opt/yarn-v1.22.22/LICENSE']) assert.ok(readFileSync(file).length > 0);
    for (const file of readdirSync('/usr/share/common-licenses')) assert.ok(readFileSync('/usr/share/common-licenses/' + file).length > 0);
    console.log(JSON.stringify({ packages: packages.length, noticesPresent: true }));
  `,
  );
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.noticesPresent, true);
  assert.ok(evidence.packages > 0);
});
