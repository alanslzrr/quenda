import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Runs the host topology a cloud VM starts (reference composition + Caddy) on
// this machine, with local stand-ins for ACME and the SMTP provider.
const execute = promisify(execFile);
const domain = "quenda.localhost";
const backend = process.env.QUENDA_IMAGE ?? "quenda-backend:local";
const web = process.env.QUENDA_WEB_IMAGE ?? "quenda-web:local";

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually<T>(
  check: () => Promise<T | undefined>,
  what: string,
  attempts = 120,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await delay(500);
  }
  assert.fail(`${what} did not happen in time`);
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

test("the cloud host topology serves Quenda over HTTPS and delivers mail over STARTTLS", {
  timeout: 600000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-deploy-"));
  const project = `quenda-verify-${randomUUID().slice(0, 8)}`;
  const [httpPort, httpsPort, webPort, mailPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const openssl = (...args: string[]) => execute("openssl", args);
  const file = (name: string) => path.join(root, name);
  const compose = (...args: string[]) =>
    execute(
      "docker",
      [
        "compose",
        "--project-name",
        project,
        "--env-file",
        file("runtime.env"),
        "-f",
        "compose.production.example.yaml",
        "-f",
        "deploy/compose.edge.yaml",
        "-f",
        "compose.smtp-ca.example.yaml",
        "-f",
        "deploy/verify/compose.verify.yaml",
        ...args,
      ],
      { timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
    );

  try {
    // Private CA for the SMTP server, as an operator with an internal relay would have.
    await openssl(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Quenda verification CA",
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.crt"),
    );
    await openssl(
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      "/CN=mailpit",
      "-keyout",
      file("smtp.key"),
      "-out",
      file("smtp.csr"),
    );
    await writeFile(file("smtp.ext"), "subjectAltName=DNS:mailpit\n");
    await openssl(
      "x509",
      "-req",
      "-in",
      file("smtp.csr"),
      "-CA",
      file("ca.crt"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      file("smtp.ext"),
      "-out",
      file("smtp.crt"),
    );
    // Read inside the containers by non-root users; the directory stays private.
    await Promise.all(
      ["ca.crt", "smtp.crt", "smtp.key"].map((name) =>
        chmod(file(name), 0o644),
      ),
    );

    const secret = () => randomBytes(24).toString("hex");
    const origin = `https://${domain}:${httpsPort}`;
    await writeFile(
      file("runtime.env"),
      Object.entries({
        QUENDA_BACKEND_IMAGE: backend,
        QUENDA_WEB_IMAGE: web,
        AUTH_ORIGIN: origin,
        AUTH_SECRET: randomBytes(32).toString("hex"),
        BOOTSTRAP_DATABASE_PASSWORD: secret(),
        MIGRATION_DATABASE_PASSWORD: secret(),
        DOMAIN_DATABASE_PASSWORD: secret(),
        AUTH_DATABASE_PASSWORD: secret(),
        WORKER_DATABASE_PASSWORD: secret(),
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "mailpit",
        SMTP_PORT: "1025",
        SMTP_USER: "quenda",
        SMTP_PASSWORD: secret(),
        SMTP_FROM: `reservas@${domain}`,
        SMTP_TLS: "starttls",
        SMTP_CA_HOST_FILE: file("ca.crt"),
        EMAIL_LOCALE: "gl",
        QUENDA_DOMAIN: domain,
        ACME_EMAIL: `operacion@${domain}`,
        QUENDA_HTTP_PUBLISH: `127.0.0.1:${httpPort}`,
        QUENDA_HTTPS_PUBLISH: `127.0.0.1:${httpsPort}`,
        QUENDA_HTTP_PORT: String(webPort),
        QUENDA_VERIFY_DIR: root,
        QUENDA_VERIFY_MAIL_PORT: String(mailPort),
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      { mode: 0o600 },
    );

    // The same three steps the host CLI runs on a new installation.
    await compose("up", "-d", "--wait", "db");
    await compose("--profile", "setup", "run", "--rm", "bootstrap");
    await compose("up", "-d", "--wait");

    // Trust only the root Caddy generated for this run.
    const ca = await eventually(async () => {
      const { stdout } = await compose(
        "exec",
        "-T",
        "caddy",
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      );
      return stdout.includes("BEGIN CERTIFICATE") ? stdout : undefined;
    }, "Caddy local CA");
    const request = (
      route: string,
      options: { method?: string; body?: unknown; port?: number } = {},
    ) =>
      new Promise<Reply>((resolve, reject) => {
        const payload =
          options.body === undefined ? undefined : JSON.stringify(options.body);
        const secure = options.port === undefined;
        const port = options.port ?? httpsPort;
        const call = (secure ? https : http).request(
          {
            host: "127.0.0.1",
            port,
            path: route,
            method: options.method ?? "GET",
            servername: domain,
            ca,
            headers: {
              host: `${domain}:${port}`,
              origin,
              ...(payload
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                  }
                : {}),
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body,
              }),
            );
          },
        );
        call.on("error", reject);
        call.end(payload);
      });
    const redirect = await request("/reservar", { port: httpPort });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `https://${domain}/reservar`);

    const page = await request("/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<div id="root"/);
    assert.match(
      String(page.headers["content-security-policy"]),
      /default-src 'self'/,
    );

    // HSTS is only emitted when nginx trusts the proxy that reports HTTPS.
    const ready = await eventually(async () => {
      const reply = await request("/health/ready");
      return reply.status === 200 ? reply : undefined;
    }, "API readiness");
    assert.equal(
      ready.headers["strict-transport-security"],
      "max-age=31536000",
    );

    const email = `vecina-${randomUUID().slice(0, 8)}@${domain}`;
    const signup = await request("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        email,
        password: "Verificacion-despliegue-2026",
        name: "Vecina de verificación",
      },
    });
    assert.equal(signup.status, 200, signup.body);

    // The verification mail crossed STARTTLS, the private CA and SMTP auth.
    const message = await eventually(async () => {
      const response = await fetch(
        `http://127.0.0.1:${mailPort}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      const result = (await response.json()) as {
        messages: { Subject: string }[];
      };
      return result.messages[0];
    }, "Verification mail delivery");
    assert.ok(message.Subject);

    const { stdout } = await compose("ps", "--all", "--format", "json");
    const services = stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            Service: string;
            State: string;
            ExitCode: number;
          },
      );
    const state = Object.fromEntries(
      services.map((service) => [service.Service, service]),
    );
    for (const name of ["db", "api", "worker", "web", "caddy"])
      assert.equal(state[name]?.State, "running", name);
    assert.equal(state.migrate?.ExitCode, 0);
  } finally {
    await compose("down", "--volumes", "--remove-orphans").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
