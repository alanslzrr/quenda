import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Validates infra/<cloud> against its local emulator with OpenTofu in a
// container: init, validate, full plan, then apply -> plan without changes ->
// destroy for the resources the emulator implements. Nothing reaches a cloud.
const execute = promisify(execFile);
const tofuImage =
  "ghcr.io/opentofu/opentofu:1.13.2@sha256:25bdfbe87000b8a88d44c7ef0cca53381da95f6203f7aed1e8cf5b81ecbe18eb";
const curlImage =
  "curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69";
const network = "quenda-emulators";
const emulators = path.resolve("infra/emulators");

interface Cloud {
  /** URL polled until it answers 2xx, from the runner's network. */
  health: string;
  /** Extra `docker run` arguments for the health probe and OpenTofu runner. */
  docker?: string[];
  /** Environment for the OpenTofu container. */
  env: Record<string, string>;
  /** Resources applied for real; the rest of the configuration is only planned. */
  targets: string[];
  /** Files written into the work directory before init. */
  prepare?: (work: string) => Promise<void>;
}

const clouds: Record<string, Cloud> = {
  oci: {
    health: "http://oci:4599/_floci/health",
    env: {
      // Read by the oracle/oci provider: per-client endpoint overrides.
      TF_VAR_CLIENT_HOST_OVERRIDES:
        "oci_identity.IdentityClient=http://oci:4599",
    },
    // floci-oci implements Identity but neither Networking nor Compute.
    targets: ["oci_identity_compartment.quenda"],
    prepare: async (work) => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      await writeFile(path.join(work, "emulator-key.pem"), privateKey, {
        mode: 0o600,
      });
    },
  },
  aws: {
    // The emulator's certificate names 127.0.0.1 only: the runner joins its
    // network namespace and reads its generated config, CA and credentials.
    health: "https://127.0.0.1:9297/__admin/health",
    docker: [
      "--network",
      "container:quenda-emulators-aws-1",
      "-v",
      "quenda-emulators_aws-emulator:/home/emulator/.aws/emulator:ro",
    ],
    env: {},
    // The security group is only planned: see infra/emulators/aws.
    targets: ["aws_eip.quenda", "aws_route_table_association.public"],
  },
  azure: {
    health: "http://azure:4577/_floci/health",
    // Go adds every certificate in SSL_CERT_DIR to the system bundle.
    env: { SSL_CERT_DIR: "/work/ca" },
    targets: [],
    prepare: async (work) => {
      await mkdir(path.join(work, "ca"));
      await docker(
        [
          "run",
          "--rm",
          "--user",
          "0",
          "--network",
          network,
          "-v",
          `${work}:/work`,
          curlImage,
          "-fsS",
          "-o",
          "/work/ca/floci-az.pem",
          "http://azure:4577/_floci/tls-cert",
        ],
        { quiet: true },
      );
    },
  },
  gcp: {
    health: "http://gcp:4588/health",
    env: { GOOGLE_OAUTH_ACCESS_TOKEN: "floci-gcp-placeholder" },
    targets: [],
  },
};

interface Phase {
  name: string;
  ok: boolean;
  seconds: number;
  detail?: string;
}

function docker(args: string[], options: { quiet?: boolean } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk;
      if (!options.quiet) process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(Object.assign(new Error(`exit ${code}`), { output, code })),
    );
  });
}

async function validate(name: string, cloud: Cloud, keep: boolean) {
  const compose = (...args: string[]) =>
    execute(
      "docker",
      ["compose", "-f", path.join(emulators, "compose.yaml"), ...args],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  const work = await mkdtemp(path.join(os.tmpdir(), `quenda-infra-${name}-`));
  const phases: Phase[] = [];
  const started = new Date();
  try {
    await compose("--profile", name, "up", "-d", "--build", name);
    let healthy = false;
    for (let attempt = 0; attempt < 90 && !healthy; attempt++) {
      healthy = await docker(
        [
          "run",
          "--rm",
          ...(cloud.docker ?? ["--network", network]),
          curlImage,
          "-fsSk",
          cloud.health,
        ],
        { quiet: true },
      ).then(
        () => true,
        () => false,
      );
      if (!healthy) await delay(1000);
    }
    if (!healthy) throw new Error(`${name} emulator did not become healthy`);

    // The root, the shared module and the CLI it embeds, plus the emulator wiring.
    const source = path.join(work, "src");
    await mkdir(path.join(source, "deploy/host"), { recursive: true });
    await cp(`infra/${name}`, path.join(source, "infra", name), {
      recursive: true,
      filter: (file) => !file.includes(".terraform/"),
    });
    await cp("infra/modules", path.join(source, "infra/modules"), {
      recursive: true,
    });
    await cp("deploy/host/quenda", path.join(source, "deploy/host/quenda"));
    await cp(
      path.join(emulators, name, "emulator_override.tf"),
      path.join(source, "infra", name, "emulator_override.tf"),
    );
    await cp(
      path.join(emulators, name, "emulator.tfvars"),
      path.join(work, "emulator.tfvars"),
    );
    await cloud.prepare?.(work);

    const tofu = (...args: string[]) =>
      docker(
        [
          "run",
          "--rm",
          ...(cloud.docker ?? ["--network", network]),
          "-v",
          `${work}:/work`,
          "-v",
          "quenda-tofu-plugins:/plugins",
          "-e",
          "TF_PLUGIN_CACHE_DIR=/plugins",
          "-e",
          "TF_IN_AUTOMATION=1",
          ...Object.entries(cloud.env).flatMap(([key, value]) => [
            "-e",
            `${key}=${value}`,
          ]),
          "-w",
          `/work/src/infra/${name}`,
          tofuImage,
          ...args,
        ],
        { quiet: true },
      );
    const common = ["-input=false", "-no-color"];
    const vars = ["-var-file=/work/emulator.tfvars", "-state=/work/state"];
    const targets = cloud.targets.map((target) => `-target=${target}`);
    const phase = async (
      phaseName: string,
      action: () => Promise<string>,
      check: (output: string) => string | undefined = () => undefined,
    ) => {
      const begin = Date.now();
      try {
        const problem = check(await action());
        phases.push({
          name: phaseName,
          ok: !problem,
          seconds: (Date.now() - begin) / 1000,
          ...(problem ? { detail: problem } : {}),
        });
        return !problem;
      } catch (error) {
        const output = (error as { output?: string }).output ?? String(error);
        phases.push({
          name: phaseName,
          ok: false,
          seconds: (Date.now() - begin) / 1000,
          detail: output.split("\n").filter(Boolean).slice(-12).join("\n"),
        });
        return false;
      }
    };

    (await phase("init", () => tofu("init", ...common))) &&
      (await phase("validate", () => tofu("validate", "-no-color"))) &&
      (await phase("plan (full configuration)", () =>
        tofu("plan", ...common, ...vars),
      )) &&
      (await phase("apply", () =>
        tofu("apply", "-auto-approve", ...common, ...vars, ...targets),
      )) &&
      (await phase("plan without changes", () =>
        tofu("plan", "-detailed-exitcode", ...common, ...vars, ...targets),
      )) &&
      (await phase("destroy", () =>
        // Untargeted: removes what was applied, dependencies included.
        tofu("destroy", "-auto-approve", ...common, ...vars),
      )) &&
      (await phase(
        "state empty",
        () => tofu("state", "list", "-state=/work/state"),
        (output) => (output.trim() ? `left in state:\n${output}` : undefined),
      ));

    const lock = await readFile(
      path.join(source, "infra", name, ".terraform.lock.hcl"),
      "utf8",
    ).catch(() => "");
    const providers = [
      ...lock.matchAll(/provider "([^"]+)" \{\s*version\s*=\s*"([^"]+)"/g),
    ].map((match) => `${match[1]} ${match[2]}`);
    const config = JSON.parse(
      (await compose("--profile", name, "config", "--format", "json")).stdout,
    ) as { services: Record<string, { image?: string; build?: unknown }> };
    const service = config.services[name];
    const report = {
      cloud: name,
      date: started.toISOString(),
      tool: tofuImage.split("@")[0],
      emulator: service?.image ?? `built from infra/emulators/${name}`,
      providers,
      applied: cloud.targets.length ? cloud.targets : ["(all resources)"],
      phases,
      ok: phases.length === 7 && phases.every((entry) => entry.ok),
    };
    await mkdir(".local/infra-validation", { recursive: true });
    await writeFile(
      `.local/infra-validation/${name}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    if (!keep)
      await compose("--profile", name, "down", "--volumes").catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const names = args.filter((arg) => arg !== "--keep");
  const selected = names.includes("all") ? Object.keys(clouds) : names;
  if (!selected.length || selected.some((name) => !clouds[name]))
    throw new Error(
      `usage: pnpm infra:validate <${Object.keys(clouds).join("|")}|all> [--keep]`,
    );
  await docker(["network", "inspect", network], { quiet: true }).catch(() =>
    docker(["network", "create", network], { quiet: true }),
  );
  let failed = false;
  for (const name of selected) {
    const report = await validate(name, clouds[name] as Cloud, keep);
    failed ||= !report.ok;
    process.stdout.write(`\n${name}: ${report.ok ? "VALIDATED" : "FAILED"}\n`);
    for (const entry of report.phases)
      process.stdout.write(
        `  ${entry.ok ? "ok  " : "FAIL"} ${entry.name} (${entry.seconds.toFixed(1)} s)${entry.detail ? `\n${entry.detail}` : ""}\n`,
      );
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: Error) => {
  process.stderr.write(`Infrastructure validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
