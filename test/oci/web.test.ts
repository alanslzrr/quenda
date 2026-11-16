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
    const trustedAddress = (
      await docker(
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        stub,
      )
    ).stdout.trim();
    await docker(
      "run",
      "-d",
      "--env",
      `QUENDA_TRUSTED_PROXY_CIDR=${trustedAddress}/32`,
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
    assert.equal(index.headers.get("x-frame-options"), "DENY");
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
      null,
      "untrusted forwarded proto is ignored",
    );
    const trusted = JSON.parse(
      (
        await docker(
          "exec",
          stub,
          "node",
          "-e",
          `fetch('http://${site}:8080/api/check', { headers: { 'x-forwarded-for': '198.51.100.5, 192.0.2.20', 'x-forwarded-proto': 'https' } }).then(async r => console.log(JSON.stringify({ hsts: r.headers.get('strict-transport-security'), data: await r.json() })))`,
        )
      ).stdout,
    );
    assert.equal(trusted.hsts, "max-age=31536000");
    assert.equal(
      trusted.data.forwardedFor,
      "192.0.2.20",
      "rightmost untrusted hop determines client identity",
    );
    assert.equal(trusted.data.forwardedProto, "https");

    // The installable app: manifest with its own media type and every icon it names.
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(
      manifest.headers.get("content-type"),
      "application/manifest+json",
    );
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.ok(manifest.headers.get("content-security-policy"));
    const icons = ((await manifest.json()) as { icons: { src: string }[] })
      .icons;
    assert.ok(icons.length >= 3);
    for (const icon of icons) {
      const image = await fetch(`${base}${icon.src}`);
      assert.equal(image.status, 200, icon.src);
      assert.equal(image.headers.get("content-type"), "image/png");
    }
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);

    const deep = await fetch(`${base}/municipios/ejemplo/unidades/otra`);
    assert.equal(deep.status, 200);
    assert.equal(await deep.text(), html);

    const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
    assert.ok(asset, "index.html must reference a hashed script");
    const script = await fetch(`${base}${asset}`);
    assert.equal(script.status, 200);
    // A raw HTTP/1.0 request exercises old proxy hops without fetch upgrading it.
    const compressed = JSON.parse(
      (
        await docker(
          "exec",
          stub,
          "node",
          "-e",
          String.raw`const net=require('net'),zlib=require('zlib'); const chunks=[]; const socket=net.connect(8080,'${site}',()=>socket.write('GET ${asset} HTTP/1.0\r\nHost: quenda.test\r\nAccept-Encoding: gzip\r\n\r\n'));socket.on('data',c=>chunks.push(c));socket.on('end',()=>{const all=Buffer.concat(chunks), split=all.indexOf('\r\n\r\n'); console.log(JSON.stringify({headers:all.subarray(0,split).toString(),bytes:zlib.gunzipSync(all.subarray(split+4)).length}));});`,
        )
      ).stdout,
    );
    assert.match(compressed.headers, /content-encoding: gzip/i);
    assert.match(compressed.headers, /vary: Accept-Encoding/i);
    assert.ok(compressed.bytes > 512);
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
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.77",
      },
    });
    assert.equal(health.status, 200);
    assert.equal(
      health.headers.get("content-security-policy"),
      "default-src 'none'; frame-ancestors 'none'",
    );
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      health.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    const forwarded = (await health.json()) as {
      url: string;
      forwardedFor: string | null;
      forwardedProto: string | null;
    };
    assert.equal(forwarded.url, "/health/ready");
    assert.equal(forwarded.forwardedProto, "http");
    assert.ok(forwarded.forwardedFor);
    assert.notEqual(forwarded.forwardedFor, "203.0.113.77");

    const api = await fetch(`${base}/api/public/municipalities?limit=1`);
    assert.equal(
      ((await api.json()) as { url: string }).url,
      "/api/public/municipalities?limit=1",
    );
    // Subscription URLs carry their secret in the path and stay out of the access log.
    const secret = "S".repeat(43);
    await fetch(`${base}/api/calendars/${secret}.ics`);
    await delay(200);
    const logged = (await docker("logs", site)).stdout;
    assert.ok(!logged.includes(secret), "subscription secret was logged");
    assert.ok(logged.includes("/api/public/municipalities"));
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
