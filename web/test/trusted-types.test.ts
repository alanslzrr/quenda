import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { allowedHtml } from "../src/app/trusted-types.ts";

// The CSP's default policy admits exactly the markup Radix Select injects. An upgrade that changes it would make every
// select throw under Trusted Types, so this test fails first and names the string to update.
test("the Trusted Types allowlist matches the stylesheet the installed Radix Select injects", async () => {
  const require = createRequire(import.meta.url);
  const source = await readFile(
    require
      .resolve("@radix-ui/react-select")
      .replace(/index\.js$/, "index.mjs"),
    "utf8",
  );
  for (const html of allowedHtml)
    assert.ok(source.includes(html), `Radix Select no longer injects: ${html}`);
  assert.match(
    source,
    /dangerouslySetInnerHTML/,
    "Radix Select still writes its stylesheet as HTML",
  );
});
