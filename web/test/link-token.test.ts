import assert from "node:assert/strict";
import test from "node:test";
import { releaseLinkToken, takeLinkToken } from "../src/app/link-token.ts";

test("a remount after the URL was cleaned still finds the token for that page", () => {
  assert.equal(takeLinkToken("/account/email-change/confirm", "abc"), "abc");
  assert.equal(takeLinkToken("/account/email-change/confirm", ""), "abc");
  assert.equal(takeLinkToken("/account/email-change/approve", ""), "");
});

test("a released token is gone and a new link replaces an old one", () => {
  takeLinkToken("/account/reactivation", "one");
  assert.equal(takeLinkToken("/account/reactivation", "two"), "two");
  releaseLinkToken("/account/reactivation");
  assert.equal(takeLinkToken("/account/reactivation", ""), "");
});
