import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dependencyPaths,
  licenseInventory,
} from "../../scripts/lib/license-inventory.ts";

test("dependency traversal includes transitive, optional and development paths but not the application", () => {
  assert.deepEqual(
    [
      ...dependencyPaths([
        {
          path: "/application",
          dependencies: {
            a: { path: "/a", dependencies: { b: { path: "/b" } } },
          },
          devDependencies: { b: { path: "/b" } },
          optionalDependencies: { c: { path: "/c" } },
        },
      ]),
    ].sort(),
    ["/a", "/b", "/c"],
  );
});
test("license inventory reports evidence hashes and gaps without exposing filesystem paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quenda-licenses-"));
  try {
    const a = path.join(root, "node_modules", "a"),
      b = path.join(root, "node_modules", "b"),
      absent = path.join(root, "node_modules", "@platform", "absent");
    for (const dir of [a, b]) await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(a, "package.json"),
      JSON.stringify({ name: "a", version: "1.0.0", license: "MIT" }),
    );
    await writeFile(path.join(a, "LICENSE"), "Exact upstream permission text");
    await writeFile(
      path.join(b, "package.json"),
      JSON.stringify({ name: "b", version: "2.0.0", license: "MIT" }),
    );
    await writeFile(
      path.join(b, "README.md"),
      "# License\nMIT: https://example.test/license",
    );
    const result = await licenseInventory(
      new Set([b, absent, a]),
      new Set([a]),
    );
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.deepEqual(result.unavailable, ["@platform/absent"]);
    assert.equal(result.packages[0]?.scope, "runtime");
    assert.equal(result.packages[1]?.reviewRequired, true);
    assert.deepEqual(result.packages[0]?.evidence, [
      {
        file: "LICENSE",
        sha256: createHash("sha256")
          .update("Exact upstream permission text")
          .digest("hex"),
      },
    ]);
    assert.ok(!JSON.stringify(result).includes(root));
    await writeFile(
      path.join(b, "README.md"),
      "Copyright Example\nPermission is hereby granted: fixture",
    );
    const withReadme = await licenseInventory(new Set([b, a]), new Set([a]));
    assert.equal(withReadme.status, "EVIDENCE_COLLECTED");
    assert.equal(withReadme.packages[1]?.evidence[0]?.file, "README.md");
    await writeFile(
      path.join(a, "ROME-LICENSE-MIT"),
      "Preserved legacy permission",
    );
    await writeFile(
      path.join(a, "ThirdPartyNoticeText.txt"),
      "Preserved upstream third-party notices",
    );
    const expanded = await licenseInventory(new Set([a]), new Set([a]));
    assert.deepEqual(
      expanded.packages[0]?.evidence.map((item) => item.file),
      ["LICENSE", "ROME-LICENSE-MIT", "ThirdPartyNoticeText.txt"],
    );
    await rm(path.join(b, "README.md"));
    await writeFile(
      path.join(b, "NOTICE"),
      "Attribution without permission text",
    );
    const noticeOnly = await licenseInventory(new Set([b]), new Set([b]));
    assert.equal(noticeOnly.status, "REVIEW_REQUIRED");
    assert.equal(noticeOnly.packages[0]?.evidence[0]?.file, "NOTICE");
    await writeFile(path.join(a, "package.json"), "invalid JSON");
    await assert.rejects(licenseInventory(new Set([a]), new Set()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
