import { randomUUID } from "node:crypto";
import { test as base } from "@playwright/test";
// Independent browsers have independent network identities in the local harness.
// The real rate limiter remains enabled; production never reads this header.
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  extraHTTPHeaders: async ({}, use) => {
    const parts = randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g);
    await use({ "x-quenda-test-client": `2001:db8:${parts?.join(":")}` });
  },
});
