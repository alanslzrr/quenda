import assert from "node:assert/strict";
import test from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import { ApiError, api } from "../src/app/api.ts";
import { canRefetch, createQueryClient } from "../src/app/query.ts";
import {
  retryAfterDeadline,
  retrySecondsLeft,
} from "../src/app/retry-after.ts";

const now = Date.parse("2026-10-24T12:00:00Z");

test("Retry-After parses seconds, including zero and surrounding whitespace", () => {
  assert.equal(retryAfterDeadline("12", now), now + 12000);
  assert.equal(retryAfterDeadline(" 2 ", now), now + 2000);
  assert.equal(retryAfterDeadline("0", now), now);
});

test("Retry-After dates account for server clock skew and expired deadlines", () => {
  assert.equal(
    retryAfterDeadline("Sat, 24 Oct 2026 12:00:45 GMT", now),
    now + 45000,
  );
  assert.equal(
    retryAfterDeadline(
      "Sat, 24 Oct 2026 10:00:45 GMT",
      now,
      "Sat, 24 Oct 2026 10:00:00 GMT",
    ),
    now + 45000,
  );
  assert.equal(retryAfterDeadline("Sat, 24 Oct 2026 11:59:00 GMT", now), now);
  assert.equal(
    retryAfterDeadline("Sat, 24 Oct 2026 12:00:45 GMT", now, "invalid"),
    now + 45000,
  );
});

test("Missing, malformed and overflowing Retry-After values have a finite fallback", () => {
  for (const header of [
    null,
    "",
    " ",
    "-1",
    "1.5",
    "1e3",
    "NaN",
    "Infinity",
    "99999999999999999999999",
    "tomorrow",
    "2026-10-25",
    "Sat, 24 Foo 2026 12:00:45 GMT",
    "Sat, 24 Oct 2099 12:00:45 GMT",
  ]) {
    assert.equal(retryAfterDeadline(header, now), now + 60000, String(header));
  }
});

test("Countdown is deadline-based, rounds up, and expires without going negative", () => {
  assert.equal(retrySecondsLeft(now + 1001, now), 2);
  assert.equal(retrySecondsLeft(now + 1000, now), 1);
  assert.equal(retrySecondsLeft(now, now), 0);
  assert.equal(retrySecondsLeft(now - 1000, now), 0);
  assert.equal(retrySecondsLeft(undefined, now), 0);
});

test("API forwards Retry-After once without replaying a rejected mutation", async (context) => {
  context.mock.method(Date, "now", () => now);
  const fetch = context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: { code: "RATE_LIMITED", message: "Espera antes de repetir." },
        requestId: "limited",
      },
      { status: 429, headers: { "Retry-After": "10" } },
    ),
  );
  await assert.rejects(
    api("/api/example", { method: "POST", body: "{}" }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.retryAt, now + 10000);
      assert.equal(error.requestId, "limited");
      return true;
    },
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("Only supported server deadlines delay automatic focus and reconnect reads", (context) => {
  context.mock.method(Date, "now", () => now);
  assert.equal(
    canRefetch(
      new ApiError(429, "RATE_LIMITED", "Wait", undefined, now + 1000),
    ),
    false,
  );
  assert.equal(
    canRefetch(new ApiError(429, "RATE_LIMITED", "Wait", undefined, now)),
    true,
  );
  assert.equal(canRefetch(new ApiError(500, "INTERNAL", "Failure")), true);
  assert.equal(canRefetch(null), true);
  assert.equal(
    new ApiError(409, "CONFLICT", "Conflict", undefined, now + 1000).retryAt,
    undefined,
  );
});

test("Non-JSON proxy 429 retains a finite cooldown and is never replayed", async (context) => {
  context.mock.method(Date, "now", () => now);
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>Rate limited</html>", {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
  );
  await assert.rejects(
    api("/api/example", { method: "POST", body: "{}" }, "es"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.retryAt, now + 3000);
      assert.equal(error.code, "RATE_LIMITED");
      assert.match(error.message, /Demasiadas solicitudes/);
      return true;
    },
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("Remounting a failed initial read does not replay it, but explicit retry still works", async () => {
  const client = createQueryClient();
  let attempts = 0;
  const options = {
    queryKey: ["failed-read"],
    queryFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(400, "INVALID", "Rejected");
      return "recovered";
    },
  };
  try {
    await assert.rejects(client.fetchQuery(options), /Rejected/);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();
    assert.equal(attempts, 1);
    assert.equal((await observer.refetch()).data, "recovered");
    assert.equal(attempts, 2);
    unsubscribe();
  } finally {
    client.clear();
  }
});

test("503 Retry-After survives proxy HTML and blocks automatic retries", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Unavailable", {
      status: 503,
      headers: { "retry-after": "60" },
    });
  try {
    await assert.rejects(api("/api/test"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(canRefetch(error), false);
      const client = createQueryClient();
      const retry = client.getDefaultOptions().queries?.retry;
      assert.equal(typeof retry, "function");
      if (typeof retry === "function") assert.equal(retry(0, error), false);
      client.clear();
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
