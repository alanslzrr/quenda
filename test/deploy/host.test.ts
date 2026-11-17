import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// What no cloud emulator executes: the VM's first boot. A systemd + cloud-init
// container receives the user data rendered by the shared Terraform module,
// then `pnpm deploy:host` ships the current revision to it over SSH.
const execute = promisify(execFile);
const tofu =
  "ghcr.io/opentofu/opentofu:1.13.2@sha256:25bdfbe87000b8a88d44c7ef0cca53381da95f6203f7aed1e8cf5b81ecbe18eb";
const domain = "quenda.localhost";
const repository = process.cwd();

const docker = (...args: string[]) =>
  execute("docker", args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });

function run(command: string, args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function eventually<T>(
  check: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await delay(500);
  }
  assert.fail(`${what} did not happen in time`);
}

test("a cloud-init host boots from the shared module and serves a shipped release", {
  timeout: 1800000,
}, async (t) => {
  const { stdout: pending } = await execute("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (pending) {
    t.skip("deploy:host ships committed revisions only; commit first");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-host-"));
  const name = `quenda-host-${randomUUID().slice(0, 8)}`;
  const image = `${name}:sim`;
  try {
    // 1. User data exactly as a cloud root renders it.
    const opentofu = (...args: string[]) =>
      docker(
        "run",
        "--rm",
        "-v",
        `${repository}:/repo:ro`,
        "-v",
        `${root}:/work`,
        "-w",
        "/repo/test/deploy/host/render",
        "-e",
        "TF_DATA_DIR=/work/.terraform",
        tofu,
        ...args,
      );
    await opentofu("init", "-input=false", "-no-color");
    await opentofu(
      "apply",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-state=/work/state",
    );
    const userData = (
      await opentofu(
        "output",
        "-no-color",
        "-state=/work/state",
        "-raw",
        "user_data",
      )
    ).stdout;
    assert.match(userData, /^#cloud-config/);

    // 2. A VM with a NoCloud seed carrying the user data and the SSH key.
    await execute("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      path.join(root, "id"),
    ]);
    const key = (await readFile(path.join(root, "id.pub"), "utf8")).trim();
    await writeFile(path.join(root, "user-data"), userData);
    await writeFile(
      path.join(root, "meta-data"),
      `instance-id: ${name}\nlocal-hostname: ${name}\npublic-keys:\n  - ${key}\n`,
    );
    await docker("build", "--tag", image, "test/deploy/host");
    await docker(
      "create",
      "--name",
      name,
      "--privileged",
      "--cgroupns=private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "--mount",
      "type=volume,dst=/var/lib/docker",
      "--mount",
      "type=volume,dst=/var/lib/containerd",
      "-p",
      "127.0.0.1::22",
      "-p",
      "127.0.0.1::443",
      image,
    );
    for (const file of ["user-data", "meta-data"])
      await docker(
        "cp",
        path.join(root, file),
        `${name}:/var/lib/cloud/seed/nocloud/${file}`,
      );
    await docker("start", name);
    const port = async (inner: number) =>
      (await docker("port", name, String(inner))).stdout
        .trim()
        .split(":")
        .pop() as string;

    try {
      await docker("exec", name, "cloud-init", "status", "--wait", "--long");
    } catch (error) {
      assert.fail(
        `cloud-init failed:\n${(error as { stdout?: string }).stdout}`,
      );
    }

    // 3. Ship the committed revision as an operator would.
    await writeFile(
      path.join(root, "ssh_config"),
      [
        `Host ${name}`,
        "  HostName 127.0.0.1",
        `  Port ${await port(22)}`,
        `  IdentityFile ${path.join(root, "id")}`,
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking no",
        "  UserKnownHostsFile /dev/null",
        "  LogLevel ERROR",
        "",
      ].join("\n"),
    );
    const sshConfig = path.join(root, "ssh_config");
    const env = { ...process.env, QUENDA_SSH_CONFIG: sshConfig };
    await run(
      "node",
      ["scripts/deploy-host.ts", `ubuntu@${name}`, "--skip-verify"],
      env,
    );
    // A second deploy of the same revision is an idempotent upgrade.
    const { stdout: revision } = await execute("git", ["rev-parse", "HEAD"]);
    await run("ssh", [
      "-F",
      sshConfig,
      `ubuntu@${name}`,
      "sudo",
      "quenda",
      "deploy",
      revision.trim(),
    ]);

    // 4. HTTPS from outside the host, trusting only this host's Caddy CA.
    const ca = (
      await docker(
        "exec",
        name,
        "quenda",
        "compose",
        "exec",
        "-T",
        "caddy",
        "cat",
        "/data/caddy/pki/authorities/local/root.crt",
      )
    ).stdout;
    const httpsPort = Number(await port(443));
    const ready = await eventually(
      () =>
        new Promise<{ status: number; hsts: unknown } | undefined>(
          (resolve, reject) => {
            https
              .get(
                {
                  host: "127.0.0.1",
                  port: httpsPort,
                  path: "/health/ready",
                  servername: domain,
                  ca,
                  headers: { host: domain },
                },
                (response) => {
                  response.resume();
                  resolve(
                    response.statusCode === 200
                      ? {
                          status: 200,
                          hsts: response.headers["strict-transport-security"],
                        }
                      : undefined,
                  );
                },
              )
              .on("error", reject);
          },
        ),
      "HTTPS readiness through the host",
    );
    assert.equal(ready.hsts, "max-age=31536000");

    // Secrets were generated on the host; the user data only carries settings.
    const files = await docker(
      "exec",
      name,
      "stat",
      "-c",
      "%n %a",
      "/etc/quenda/secrets.env",
      "/etc/quenda/runtime.env",
    );
    assert.deepEqual(files.stdout.trim().split("\n"), [
      "/etc/quenda/secrets.env 600",
      "/etc/quenda/runtime.env 600",
    ]);
    const settings = (await docker("exec", name, "cat", "/etc/quenda/host.env"))
      .stdout;
    assert.doesNotMatch(settings, /PASSWORD|SECRET/);
  } finally {
    await docker("rm", "--force", "--volumes", name).catch(() => {});
    await docker("image", "rm", image).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
