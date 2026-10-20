import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildApp } from "../../src/app.ts";
import { loadSourceOffer } from "../../src/http/source-offer.ts";

const database = {
  check: async () => {
    throw new Error("offline");
  },
  close: async () => {},
};
test("source offer serves verified bytes without authentication or database and is stable after file replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-source-http-"));
  try {
    const filename = path.join(root, "source.tar.gz");
    const bytes = gzipSync("synthetic source payload"),
      revision = "a".repeat(40);
    await writeFile(filename, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const offer = await loadSourceOffer({
      SOURCE_ARCHIVE_PATH: filename,
      SOURCE_ARCHIVE_SHA256: sha256,
      SOURCE_REVISION: revision,
    });
    assert.ok(offer);
    const app = await buildApp({
      database,
      sourceOffer: offer,
      logLevel: "silent",
    });
    try {
      await writeFile(filename, "changed after initialization");
      const response = await app.inject({ url: "/legal/source" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, bytes);
      assert.equal(response.headers["x-source-sha256"], sha256);
      assert.equal(response.headers["x-source-revision"], revision);
      assert.equal(response.headers["content-type"], "application/gzip");
      assert.equal(
        response.headers["content-disposition"],
        `attachment; filename="quenda-${revision}.tar.gz"`,
      );
      assert.ok(!response.headers["set-cookie"]);
      const health = await app.inject({ url: "/health/ready" });
      assert.equal(health.statusCode, 503);
      assert.match(String(health.headers.link), /\/legal\/source/);
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("source offer fails closed when absent or invalid, without leaking paths", async () => {
  assert.equal(await loadSourceOffer({}), undefined);
  for (const env of [
    { SOURCE_REVISION: "a".repeat(40) },
    {
      SOURCE_ARCHIVE_PATH: "/private/secret/file",
      SOURCE_ARCHIVE_SHA256: "0".repeat(64),
      SOURCE_REVISION: "a".repeat(40),
    },
    {
      SOURCE_ARCHIVE_PATH: "/private/secret/file",
      SOURCE_ARCHIVE_SHA256: "invalid",
      SOURCE_REVISION: "a".repeat(40),
    },
  ]) {
    await assert.rejects(loadSourceOffer(env), {
      message: "Invalid configuration: SOURCE_ARCHIVE",
    });
  }
  const app = await buildApp({ database, logLevel: "silent" });
  try {
    const response = await app.inject({ url: "/legal/source" });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.headers.link);
  } finally {
    await app.close();
  }
});

test("source loader rejects checksum mismatch, non-gzip payload and oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-source-invalid-"));
  try {
    const filename = path.join(root, "source.tar.gz");
    for (const [bytes, suppliedHash] of [
      [gzipSync("fixture"), "0".repeat(64)],
      [Buffer.from("not gzip"), undefined],
      [Buffer.alloc(16 * 1024 * 1024 + 1), undefined],
      [Buffer.alloc(0), undefined],
    ] as const) {
      await writeFile(filename, bytes);
      await assert.rejects(
        loadSourceOffer({
          SOURCE_ARCHIVE_PATH: filename,
          SOURCE_ARCHIVE_SHA256:
            suppliedHash ?? createHash("sha256").update(bytes).digest("hex"),
          SOURCE_REVISION: "a".repeat(40),
        }),
        { message: "Invalid configuration: SOURCE_ARCHIVE" },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
