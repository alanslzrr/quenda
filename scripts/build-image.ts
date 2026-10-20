import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareImageContext } from "./lib/image-context.ts";

async function run() {
  const [tag = "quenda-backend:local", ...extra] = process.argv.slice(2);
  if (extra.length || !/^[a-z0-9][a-z0-9._/:-]*$/.test(tag))
    throw new Error("Invalid image tag");
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-image-"));
  try {
    const source = await prepareImageContext(process.cwd(), root);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "build",
          "--tag",
          tag,
          "--build-arg",
          `SOURCE_REVISION=${source.revision}`,
          "--build-arg",
          `SOURCE_ARCHIVE_SHA256=${source.sha256}`,
          source.context,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Image build failed")),
      );
    });
    process.stdout.write(
      `${JSON.stringify({ image: tag, revision: source.revision, sourceSha256: source.sha256 })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
run().catch(() => {
  process.stderr.write(
    "Source-bound image build failed; no image is approved for release\n",
  );
  process.exitCode = 1;
});
