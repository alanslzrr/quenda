import assert from "node:assert/strict";
import test from "node:test";
import { browserStorage } from "../src/app/storage.ts";
import {
  forgetCommand,
  type PendingCommand,
  readCommand,
  sendCommand,
} from "../src/features/reservations/commands.ts";

function blockedWindow() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage(): never {
        throw new DOMException("blocked", "SecurityError");
      },
      get sessionStorage(): never {
        throw new DOMException("blocked", "SecurityError");
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  };
}
const command: PendingCommand = {
  owner: "ana",
  path: "/api/municipalities/00000000-0000-4000-8000-000000000101/reservations",
  key: "key",
  body: "{}",
  createdAt: Date.now(),
  retentionSeconds: 3600,
};

test("blocked site data yields no storage instead of throwing at property access", () => {
  const restore = blockedWindow();
  try {
    assert.equal(browserStorage("local"), undefined);
    assert.equal(browserStorage("session"), undefined);
  } finally {
    restore();
  }
});

test("pending-command helpers tolerate blocked storage", () => {
  const restore = blockedWindow();
  try {
    assert.equal(readCommand("ana"), null);
    assert.doesNotThrow(() => forgetCommand());
  } finally {
    restore();
  }
});

test("a command is never sent when the uncertainty marker cannot be stored", async () => {
  const restore = blockedWindow();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({});
  };
  try {
    await assert.rejects(sendCommand(command, "es"), {
      code: "STORAGE_UNAVAILABLE",
    });
    assert.equal(requests, 0);
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    globalThis.fetch = async (path) =>
      String(path).endsWith("command-policy")
        ? Response.json({
            retentionSeconds: 3600,
            serverTime: new Date().toISOString(),
          })
        : Response.json({}, { status: 201 });
    await assert.rejects(sendCommand(command, "gl", false, failing), {
      code: "STORAGE_UNAVAILABLE",
    });
    // A later command must not be blocked by the failed attempt.
    await assert.rejects(sendCommand(command, "es"), {
      code: "STORAGE_UNAVAILABLE",
    });
  } finally {
    globalThis.fetch = original;
    restore();
  }
});
