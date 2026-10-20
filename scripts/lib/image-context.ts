import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sourceArchive } from "./source-archive.ts";

const execute = promisify(execFile);

// The caller owns a new private temporary directory and removes it on completion.
export async function prepareImageContext(
  repository: string,
  directory: string,
) {
  const archive = await sourceArchive(
    repository,
    path.join(directory, "source.tar.gz"),
  );
  const context = path.join(directory, "context");
  await mkdir(context);
  await execute("tar", [
    "-xzf",
    archive.path,
    "--strip-components=1",
    "-C",
    context,
  ]);
  // Reject a tracked source-offer directory rather than replacing its contents.
  const source = path.join(context, ".source");
  await mkdir(source);
  await copyFile(archive.path, path.join(source, "source.tar.gz"));
  return { context, revision: archive.revision, sha256: archive.sha256 };
}
