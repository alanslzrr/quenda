import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

// Ships the current clean revision to a host prepared by `quenda install`:
// builds the images for the host architecture, verifies them locally when the
// architecture matches, then transfers release files and images over SSH.
const execute = promisify(execFile);

function run(command: string, args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0]} exited with ${code}`)),
    );
  });
}

/** `producer | consumer`, failing if either side fails. */
function pipe(producer: string[], consumer: string[]) {
  return new Promise<void>((resolve, reject) => {
    const left = spawn(producer[0] as string, producer.slice(1), {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const right = spawn(consumer[0] as string, consumer.slice(1), {
      stdio: ["pipe", "inherit", "inherit"],
    });
    left.stdout.pipe(right.stdin);
    let pending = 2;
    const done = (name: string) => (code: number | null) => {
      if (code !== 0) reject(new Error(`${name} exited with ${code}`));
      else if (--pending === 0) resolve();
    };
    left.on("error", reject).on("exit", done(producer[0] as string));
    right.on("error", reject).on("exit", done(consumer[0] as string));
  });
}

async function imageArchitecture(tag: string) {
  try {
    const { stdout } = await execute("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Architecture}}",
      tag,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(["--skip-verify", "--demo"]);
  const skipVerify = args.includes("--skip-verify");
  // --demo also ships the demo seeder and loads its dataset once.
  const demo = args.includes("--demo");
  const [target, ...extra] = args.filter((arg) => !flags.has(arg));
  if (!target || extra.length || !/^[\w.-]+@[\w.:-]+$/.test(target))
    throw new Error(
      "usage: pnpm deploy:host <user>@<host> [--demo] [--skip-verify]",
    );
  // QUENDA_SSH_CONFIG selects an ssh_config file (ports, keys, jump hosts).
  const config = process.env.QUENDA_SSH_CONFIG;
  const remote = (...command: string[]) => [
    ...(config ? ["-F", config] : []),
    "-o",
    "BatchMode=yes",
    target,
    ...command,
  ];

  const git = async (...rest: string[]) =>
    (await execute("git", rest)).stdout.trim();
  if (await git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Commit or remove pending changes before deploying");
  const revision = await git("rev-parse", "--verify", "HEAD");

  const machine = (await execute("ssh", remote("uname", "-m"))).stdout.trim();
  const arch = (
    { x86_64: "amd64", aarch64: "arm64" } as Record<string, string>
  )[machine];
  if (!arch) throw new Error(`Unsupported host architecture ${machine}`);
  const platform = `linux/${arch}`;
  const backend = `quenda-backend:${revision}`;
  const web = `quenda-web:${revision}`;
  const seeder = `quenda-demo:${revision}`;

  if ((await imageArchitecture(backend)) !== arch)
    await run("node", ["scripts/build-image.ts", backend], {
      ...process.env,
      DOCKER_DEFAULT_PLATFORM: platform,
    });
  if ((await imageArchitecture(web)) !== arch)
    await run("docker", [
      "build",
      "--platform",
      platform,
      "--file",
      "web/Dockerfile",
      "--tag",
      web,
      "--build-arg",
      `SOURCE_REVISION=${revision}`,
      ".",
    ]);
  if (demo && (await imageArchitecture(seeder)) !== arch)
    await run("docker", [
      "build",
      "--platform",
      platform,
      "--file",
      "deploy/demo/Dockerfile",
      "--tag",
      seeder,
      "--build-arg",
      `SOURCE_REVISION=${revision}`,
      ".",
    ]);

  const local = ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[
    os.arch()
  ];
  if (skipVerify) console.warn("Skipping the local topology verification");
  else if (local === arch)
    await run("node", ["--test", "test/deploy/stack.test.ts"], {
      ...process.env,
      QUENDA_IMAGE: backend,
      QUENDA_WEB_IMAGE: web,
    });
  else
    console.warn(
      `Host is ${arch} and this machine ${local}: the images were not run locally`,
    );

  await pipe(
    [
      "git",
      "archive",
      "--format=tar",
      revision,
      "compose.production.example.yaml",
      "compose.smtp-ca.example.yaml",
      "deploy",
    ],
    ["ssh", ...remote("sudo", "quenda", "receive", revision)],
  );
  // docker load accepts the gzip stream directly.
  const images = demo ? [backend, web, seeder] : [backend, web];
  await pipe(
    ["sh", "-c", 'docker save "$@" | gzip -1', "save", ...images],
    ["ssh", ...remote("sudo", "docker", "load")],
  );
  await run("ssh", remote("sudo", "quenda", "deploy", revision));
  if (demo) await run("ssh", remote("sudo", "quenda", "demo", "seed"));
}

main().catch((error: Error) => {
  process.stderr.write(`Deployment failed: ${error.message}\n`);
  process.exitCode = 1;
});
