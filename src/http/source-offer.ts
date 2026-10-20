import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { ConfigurationError } from "../config.ts";
import { HttpError } from "./errors.ts";

export interface SourceOffer {
  revision: string;
  sha256: string;
  bytes: Buffer;
}
const maximumBytes = 16 * 1024 * 1024;
export async function loadSourceOffer(
  env: NodeJS.ProcessEnv,
): Promise<SourceOffer | undefined> {
  const fields = [
    env.SOURCE_ARCHIVE_PATH,
    env.SOURCE_ARCHIVE_SHA256,
    env.SOURCE_REVISION,
  ];
  if (fields.every((value) => !value)) return undefined;
  const [filename, sha256, revision] = fields;
  if (
    !filename ||
    !sha256 ||
    !revision ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)
  )
    throw new ConfigurationError("SOURCE_ARCHIVE");
  try {
    const file = await open(filename, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 3 || stat.size > maximumBytes)
        throw new Error("Invalid archive size");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) throw new Error("Truncated archive");
        offset += read.bytesRead;
      }
      if (
        !bytes.subarray(0, 3).equals(Buffer.from([0x1f, 0x8b, 0x08])) ||
        createHash("sha256").update(bytes).digest("hex") !== sha256
      )
        throw new Error("Invalid archive checksum");
      return { revision, sha256, bytes };
    } finally {
      await file.close();
    }
  } catch {
    throw new ConfigurationError("SOURCE_ARCHIVE");
  }
}
export function registerSourceOffer(app: FastifyInstance, offer?: SourceOffer) {
  if (offer)
    app.addHook("onRequest", async (_request, reply) => {
      reply.header(
        "link",
        '</legal/source>; rel="related"; title="AGPL corresponding source"; type="application/gzip"',
      );
    });
  app.get(
    "/legal/source",
    {
      schema: {
        operationId: "downloadCorrespondingSource",
        tags: ["Legal"],
        description:
          "Download the configured source archive for this release without authentication. Deployment must bind the archive revision to the running artifact.",
        response: {
          200: {
            content: {
              "application/gzip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          503: { $ref: "ErrorResponse#" },
        },
      },
    },
    async (_request, reply) => {
      if (!offer) throw new HttpError("UNAVAILABLE");
      return reply
        .type("application/gzip")
        .header(
          "content-disposition",
          `attachment; filename="quenda-${offer.revision}.tar.gz"`,
        )
        .header("x-source-revision", offer.revision)
        .header("x-source-sha256", offer.sha256)
        .header("etag", `"${offer.sha256}"`)
        .header("cache-control", "no-cache")
        .header("x-content-type-options", "nosniff")
        .send(offer.bytes);
    },
  );
}
