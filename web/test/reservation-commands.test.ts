import assert from "node:assert/strict";
import test from "node:test";
import {
  commandResultPath,
  commandReviewPath,
  forgetCommand,
  type PendingCommand,
  pendingKey,
  readCommand,
  retryAllowed,
  sendCommand,
} from "../src/features/reservations/commands.ts";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
};
const command = (): PendingCommand => ({
  owner: "ana",
  path: "/api/municipalities/00000000-0000-4000-8000-000000000101/reservations",
  key: "single-key",
  body: JSON.stringify({
    unitId: "unit",
    acceptance: { usageRulesVersion: 1 },
  }),
  createdAt: Date.now(),
  retentionSeconds: 3600,
});
test("uncertain commands survive reload and replay exactly once with the original key and body", async () => {
  const saved = storage();
  const item = command();
  const original = globalThis.fetch;
  const sent: RequestInit[] = [];
  globalThis.fetch = async (path, options) => {
    if (String(path).endsWith("command-policy"))
      return Response.json({
        retentionSeconds: 3600,
        serverTime: new Date().toISOString(),
      });
    assert.ok(options);
    sent.push(options);
    if (sent.length === 1) throw new TypeError("Connection lost after commit");
    return Response.json({ id: "same-reservation" });
  };
  try {
    await assert.rejects(sendCommand(item, "es", false, saved));
    assert.deepEqual(readCommand("ana", saved), item);
    assert.equal(sent.length, 1);
    assert.equal(readCommand("other", saved), null);
    assert.deepEqual(await sendCommand(item, "es", true, saved), {
      id: "same-reservation",
    });
    assert.equal(sent.length, 2);
    assert.equal(
      new Headers(sent[0].headers).get("Idempotency-Key"),
      new Headers(sent[1].headers).get("Idempotency-Key"),
    );
    assert.equal(sent[0].body, sent[1].body);
    assert.equal(readCommand("ana", saved), null);
  } finally {
    globalThis.fetch = original;
  }
});
test("expired or shortened retention never sends a mutation", async () => {
  const saved = storage();
  const item = command();
  item.createdAt -= 100000;
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (_path, options) => {
    if (options?.method === "POST") posts++;
    return Response.json({
      retentionSeconds: 10,
      serverTime: new Date().toISOString(),
    });
  };
  try {
    await assert.rejects(
      sendCommand(item, "es", true, saved),
      /plazo de reintento/,
    );
    assert.equal(posts, 0);
    assert.equal(retryAllowed(item, item.createdAt - 1), false);
    assert.equal(retryAllowed(item, item.createdAt + 3600000), false);
  } finally {
    globalThis.fetch = original;
  }
});
test("definitive rejection clears a new command but an in-flight replay conflict retains its evidence", async () => {
  const saved = storage();
  const original = globalThis.fetch;
  globalThis.fetch = async (path) =>
    String(path).endsWith("command-policy")
      ? Response.json({
          retentionSeconds: 3600,
          serverTime: new Date().toISOString(),
        })
      : Response.json(
          { error: { code: "CONFLICT", message: "Conflict" } },
          { status: 409 },
        );
  try {
    await assert.rejects(sendCommand(command(), "es", false, saved));
    assert.equal(saved.length, 0);
    await assert.rejects(sendCommand(command(), "es", true, saved));
    assert.ok(readCommand("ana", saved));
    forgetCommand(saved);
    assert.equal(saved.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("malformed stored paths cannot send arbitrary authenticated requests", () => {
  const saved = storage();
  saved.setItem(
    pendingKey,
    JSON.stringify({ ...command(), path: "/api/auth/delete-user" }),
  );
  assert.equal(readCommand("ana", saved), null);
});

test("a second form cannot overwrite an in-flight or uncertain command", async () => {
  const saved = storage();
  const first = command();
  const second = { ...command(), key: "second-key" };
  const original = globalThis.fetch;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  globalThis.fetch = async (path) => {
    if (String(path).endsWith("command-policy"))
      return Response.json({
        retentionSeconds: 3600,
        serverTime: new Date().toISOString(),
      });
    posts++;
    await gate;
    throw new TypeError("Unknown outcome");
  };
  try {
    const running = sendCommand(first, "es", false, saved);
    await assert.rejects(
      sendCommand(second, "es", false, saved),
      /operación anterior/,
    );
    release();
    await assert.rejects(running);
    assert.equal(posts, 1);
    assert.equal(readCommand("ana", saved)?.key, first.key);
    await assert.rejects(
      sendCommand(second, "es", false, saved),
      /operación anterior/,
    );
    assert.equal(readCommand("ana", saved)?.key, first.key);
  } finally {
    release();
    globalThis.fetch = original;
  }
});

test("collaboration recovery accepts only supported commands and keeps exact version targets", async () => {
  const { commandReviewPath, commandResultPath } = await import(
    "../src/features/reservations/commands.ts"
  );
  const saved = storage(),
    tenant = "00000000-0000-4000-8000-000000000101",
    id = "00000000-0000-4000-8000-000000000102";
  const base = `/api/municipalities/${tenant}`,
    view = `/administracion/${tenant}`;
  for (const suffix of [
    "agreements",
    `agreements/${id}/versions`,
    `agreements/${id}/approve`,
    `agreements/${id}/activate`,
    `agreements/${id}/suspend`,
    "credentials",
    `credentials/${id}/revoke`,
    `units/${id}/agreement-restriction/release`,
  ]) {
    const item = {
      ...command(),
      path: `${base}/${suffix}`,
      body: JSON.stringify({ expectedVersion: 3 }),
    };
    saved.setItem(pendingKey, JSON.stringify(item));
    assert.deepEqual(readCommand("ana", saved), item);
  }
  for (const suffix of [
    `agreements/${id}/delete`,
    `credentials/${id}/approve`,
    `units/${id}/agreement-restriction/release/extra`,
    "agreements?override=true",
  ]) {
    saved.setItem(
      pendingKey,
      JSON.stringify({ ...command(), path: `${base}/${suffix}` }),
    );
    assert.equal(readCommand("ana", saved), null);
  }
  const version = {
    ...command(),
    path: `${base}/agreements/${id}/versions`,
    body: JSON.stringify({ expectedVersion: 3 }),
  };
  assert.equal(
    commandReviewPath(version),
    `${view}/convenios/${id}/versiones/3`,
  );
  assert.equal(
    commandResultPath(version, { agreementId: id, version: 4 }),
    `${view}/convenios/${id}/versiones/4`,
  );
  const credential = { ...command(), path: `${base}/credentials` };
  assert.equal(
    commandResultPath(credential, { id }),
    `${view}/acreditaciones?referencia=${id}`,
  );
  const release = {
    ...command(),
    path: `${base}/units/${id}/agreement-restriction/release`,
  };
  assert.equal(
    commandResultPath(release, { unitId: id }),
    `${view}/convenios/unidades/${id}/reapertura`,
  );
});

test("replay authorization failures retain the original uncertain command until its outcome is resolved", async () => {
  const saved = storage(),
    item = command(),
    original = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 409, 422, 429]) {
      globalThis.fetch = async (path) =>
        String(path).endsWith("command-policy")
          ? Response.json({
              retentionSeconds: 3600,
              serverTime: new Date().toISOString(),
            })
          : Response.json(
              {
                error: {
                  code: "REAUTHENTICATION_REQUIRED",
                  message: "Verify again",
                },
              },
              { status },
            );
      await assert.rejects(sendCommand(item, "es", true, saved));
      assert.deepEqual(readCommand("ana", saved), item);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("monthly review recovery accepts only exact review commands and never routes to an agreement version", () => {
  const saved = storage(),
    tenant = "00000000-0000-4000-8000-000000000101",
    id = "00000000-0000-4000-8000-000000000102";
  const item = {
    ...command(),
    path: `/api/municipalities/${tenant}/agreements/${id}/reports/2024-03/reviews`,
    body: JSON.stringify({
      revision: 2,
      expectedHistoryDigest: "a".repeat(64),
    }),
  };
  saved.setItem(pendingKey, JSON.stringify(item));
  assert.deepEqual(readCommand("ana", saved), item);
  assert.equal(
    commandReviewPath(item),
    `/administracion/${tenant}/informes/revision`,
  );
  assert.equal(
    commandResultPath(item, {
      agreementId: id,
      reviewId: "12",
      decision: "APPROVE",
    }),
    `/administracion/${tenant}/informes/revision`,
  );
  for (const path of [
    item.path.replace("2024-03", "2024-13"),
    item.path.replace("reviews", "review-context"),
    `${item.path}?revision=2`,
  ]) {
    saved.setItem(pendingKey, JSON.stringify({ ...item, path }));
    assert.equal(readCommand("ana", saved), null);
  }
});

test("unavailable or inconsistent recovery clocks never imply expiry or send a write", async () => {
  const saved = storage();
  const item = command();
  saved.setItem(pendingKey, JSON.stringify(item));
  const original = globalThis.fetch;
  let writes = 0;
  try {
    for (const serverTime of [
      "invalid",
      new Date(item.createdAt - 1000).toISOString(),
    ]) {
      globalThis.fetch = async (_path, options) => {
        if (options?.method === "POST") writes++;
        return Response.json({ retentionSeconds: 3600, serverTime });
      };
      await assert.rejects(
        sendCommand(item, "es", true, saved),
        /Cannot establish/,
      );
      assert.deepEqual(readCommand("ana", saved), item);
    }
    assert.equal(writes, 0);
    assert.equal(retryAllowed(item, item.createdAt + 3594999), true);
    assert.equal(retryAllowed(item, item.createdAt + 3595000), false);
  } finally {
    globalThis.fetch = original;
  }
});
