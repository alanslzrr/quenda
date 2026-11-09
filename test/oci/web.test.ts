import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const web = process.env.QUENDA_WEB_IMAGE ?? "quenda-web:local";
const runtime = process.env.QUENDA_IMAGE ?? "quenda-backend:local";
const docker = (...args: string[]) =>
  execute("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 });

const upstream = `require("http").createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify({ url: request.url, forwardedFor: request.headers["x-forwarded-for"] ?? null, forwardedProto: request.headers["x-forwarded-proto"] ?? null }));
}).listen(3000)`;

test("the web image serves the bundle with strict headers and proxies the API", {
  timeout: 120000,
}, async () => {
  const network = `quenda-web-test-${randomUUID()}`;
  const stub = `${network}-api`,
    site = `${network}-web`;
  await docker("network", "create", network);
  try {
    await docker(
      "run",
      "-d",
      "--name",
      stub,
      "--network",
      network,
      "--network-alias",
      "api",
      "--read-only",
      "--cap-drop=ALL",
      runtime,
      "-e",
      upstream,
    );
    await docker(
      "run",
      "-d",
      "--name",
      site,
      "--network",
      network,
      "--publish",
      "127.0.0.1::8080",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/etc/nginx/conf.d:uid=101,gid=101",
      web,
    );
    const port = (await docker("port", site, "8080/tcp")).stdout
      .trim()
      .split("\n")[0]
      ?.split(":")
      .pop();
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      ready = await fetch(`${base}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await delay(250);
    }
    assert.ok(ready, "web container did not become ready");

    assert.equal(
      (await docker("exec", site, "id", "-u")).stdout.trim(),
      "101",
      "the server must not run as root",
    );
    assert.equal(
      (
        await docker(
          "exec",
          site,
          "sh",
          "-c",
          "find /usr/share/nginx/html -name '*.map' | wc -l",
        )
      ).stdout.trim(),
      "0",
      "source maps must not ship",
    );

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    const policy = index.headers.get("content-security-policy") ?? "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ])
      assert.ok(policy.includes(directive), directive);
    assert.ok(!policy.includes("unsafe-eval"));
    assert.ok(!/script-src[^;]*unsafe-inline/.test(policy));
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.equal(index.headers.get("referrer-policy"), "no-referrer");
    assert.equal(
      index.headers.get("cross-origin-opener-policy"),
      "same-origin",
    );
    assert.ok(index.headers.get("permissions-policy")?.includes("camera=()"));
    assert.equal(index.headers.get("strict-transport-security"), null);
    assert.equal(index.headers.get("server"), "nginx");
    const html = await index.text();

    const secure = await fetch(`${base}/`, {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(
      secure.headers.get("strict-transport-security"),
      "max-age=31536000",
    );

    const deep = await fetch(`${base}/municipios/ejemplo/unidades/otra`);
    assert.equal(deep.status, 200);
    assert.equal(await deep.text(), html);

    const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
    assert.ok(asset, "index.html must reference a hashed script");
    const script = await fetch(`${base}${asset}`);
    assert.equal(script.status, 200);
    assert.equal(
      script.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal((await fetch(`${base}${asset}.map`)).status, 404);
    const missing = await fetch(`${base}/assets/ausente-12345678.js`);
    assert.equal(missing.status, 404);
    assert.notEqual(
      await missing.text(),
      html,
      "a missing chunk must not be answered with the application shell",
    );

    const health = await fetch(`${base}/health/ready`, {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(health.status, 200);
    assert.equal(
      health.headers.get("content-security-policy"),
      "default-src 'none'; frame-ancestors 'none'",
    );
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    const forwarded = (await health.json()) as {
      url: string;
      forwardedFor: string | null;
      forwardedProto: string | null;
    };
    assert.equal(forwarded.url, "/health/ready");
    assert.equal(forwarded.forwardedProto, "https");
    assert.ok(forwarded.forwardedFor);

    const api = await fetch(`${base}/api/public/municipalities?limit=1`);
    assert.equal(
      ((await api.json()) as { url: string }).url,
      "/api/public/municipalities?limit=1",
    );
    const source = await fetch(`${base}/legal/source`);
    assert.equal(
      ((await source.json()) as { url: string }).url,
      "/legal/source",
    );
    assert.equal(
      (await fetch(`${base}/legal/otra`)).headers
        .get("content-type")
        ?.startsWith("text/html"),
      true,
      "other /legal paths belong to the application",
    );
  } finally {
    await docker("rm", "-f", site, stub).catch(() => undefined);
    await docker("network", "rm", network).catch(() => undefined);
  }
});
