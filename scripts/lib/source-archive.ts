import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function sourceArchive(repository: string, destination: string) {
  const git = async (...args: string[]) =>
    (
      await execute("git", ["-c", "core.attributesFile=/dev/null", ...args], {
        cwd: repository,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  const revision = (await git("rev-parse", "--verify", "HEAD")).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("Invalid source revision");
  if (
    (await git("status", "--porcelain", "-z", "--untracked-files=all")).length
  )
    throw new Error("Commit or remove pending changes before packaging");
  const tree = (await git("ls-tree", "-r", "-z", revision))
    .split("\0")
    .filter(Boolean);
  const files = tree.map((entry) => {
    const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/s.exec(entry);
    if (!match?.[2])
      throw new Error("Source archives require regular tracked files");
    const name = match[2];
    if (
      name
        .split("/")
        .some(
          (part) =>
            part === ".gitattributes" ||
            part === "node_modules" ||
            part === ".local" ||
            part === "dist" ||
            part === ".aws" ||
            (part.startsWith(".env") && !part.endsWith(".example")),
        ) ||
      /\.(pem|key|p12|pfx|dump)$/i.test(name)
    )
      throw new Error("Review restricted tracked files before packaging");
    return name;
  });
  for (const required of [
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "Dockerfile",
  ])
    if (!files.includes(required)) throw new Error("Incomplete source tree");
  const manifest = JSON.parse(await git("show", `${revision}:package.json`));
  if (manifest.license !== "AGPL-3.0-only")
    throw new Error("Unexpected project license");
  const attributes = (
    await git("rev-parse", "--git-path", "info/attributes")
  ).trim();
  try {
    if ((await readFile(path.resolve(repository, attributes), "utf8")).trim())
      throw new Error("Local archive attributes are not allowed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const output = path.resolve(destination);
  const staging = await mkdtemp(
    path.join(path.dirname(output), ".quenda-source-"),
  );
  const temporary = path.join(staging, "source.tar.gz");
  try {
    await git(
      "archive",
      "--format=tar.gz",
      `--prefix=quenda-${revision}/`,
      `--output=${temporary}`,
      revision,
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    await link(temporary, output);
    return {
      revision,
      sha256: hash.digest("hex"),
      path: output,
      trackedFiles: files.length,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
