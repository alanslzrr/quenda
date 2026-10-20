import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPrivacyCheckpoint } from "../../scripts/lib/privacy-checkpoint.ts";

test("privacy checkpoint reader validates complete typed evidence, ordering and external integrity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quenda-checkpoint-"));
  const file = path.join(directory, "checkpoint.json");
  const valid = {
    format: "quenda.privacy-checkpoint",
    version: 1,
    instanceId: randomUUID(),
    generatedAt: new Date().toISOString(),
    ledgerHead: "42",
    actions: [
      {
        id: "42",
        operation: "RETENTION_APPLIED",
        policyId: null,
        authorizationReference: "Approved authority",
        actorId: null,
        reason: null,
        tenantId: null,
        category: "AUTHENTICATION",
        targetKey: "session-event:synthetic",
        subjectId: "synthetic",
        action: "ERASE",
        cutoff: "2026-01-01T00:00:00.123456Z",
        occurredAt: "2026-02-01T00:00:00.123456Z",
        archiveId: null,
        destroyAfter: null,
        archiveDestroyed: false,
      },
    ],
    holds: [],
  };
  const read = async (document: unknown) => {
    const bytes = JSON.stringify(document);
    await writeFile(file, bytes, { mode: 0o600 });
    return readPrivacyCheckpoint(
      file,
      createHash("sha256").update(bytes).digest("hex"),
    );
  };
  try {
    assert.deepEqual(await read(valid), valid);
    await assert.rejects(
      readPrivacyCheckpoint(file, "0".repeat(64)),
      /checksum/,
    );
    for (const changed of [
      null,
      {},
      { ...valid, ledgerHead: "41" },
      { ...valid, instanceId: "not-an-instance" },
      { ...valid, actions: [null] },
      {
        ...valid,
        actions: [
          { ...valid.actions[0], operation: "RESTORE_SUPPRESSION_REPLAYED" },
        ],
      },
      { ...valid, actions: [{ ...valid.actions[0], subjectId: 42 }] },
      { ...valid, actions: [{ ...valid.actions[0], action: "BLOCK" }] },
      { ...valid, actions: [valid.actions[0], valid.actions[0]] },
      { ...valid, holds: [{ id: randomUUID() }] },
    ])
      await assert.rejects(read(changed), /Invalid privacy checkpoint/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
