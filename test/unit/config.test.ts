import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../../src/config.ts";
import { language } from "../../src/http/errors.ts";
import type { Clock } from "../../src/shared/clock.ts";

const env = {
  DOMAIN_DATABASE_URL: "postgresql://domain:secret@localhost/quenda",
  AUTH_DATABASE_URL: "postgresql://auth:another@localhost/quenda",
  AUTH_ORIGIN: "https://quenda.test",
  AUTH_SECRET: "test-config-only-not-a-deployed-secret",
};

test("configuration has safe defaults and rejects invalid values without secrets", () => {
  assert.equal(readConfig(env).host, "127.0.0.1");
  for (const override of [
    { PORT: "0" },
    { PORT: "3.5" },
    { PORT: "65536" },
    { DATABASE_POOL_MAX: "0" },
    { LOG_LEVEL: "all" },
    { DOMAIN_DATABASE_URL: "https://domain:TOPSECRET@host/db" },
    { AUTH_DATABASE_URL: env.DOMAIN_DATABASE_URL },
    { AUTH_DATABASE_URL: "postgresql://auth:TOPSECRET@other/db" },
    { MIGRATION_DATABASE_URL: "TOPSECRET" },
    { BOOTSTRAP_DATABASE_URL: "TOPSECRET" },
    { MIGRATION_DATABASE_PASSWORD: "TOPSECRET" },
    { BOOTSTRAP_DATABASE_PASSWORD: "TOPSECRET" },
    { AUTH_ORIGIN: "http://quenda.example.org" },
    { AUTH_ORIGIN: "https://quenda.example.org/redirect" },
    { AUTH_SECRET: "short" },
    { NODE_ENV: "production" },
  ]) {
    assert.throws(
      () => readConfig({ ...env, ...override }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Invalid configuration:/);
        assert.ok(!error.message.includes("TOPSECRET"));
        return true;
      },
    );
  }
});

test("language selection respects quality, region, exclusions and fallback", () => {
  assert.equal(language("gl-ES,es;q=0.8"), "gl");
  assert.equal(language("gl;q=0,es;q=1"), "es");
  assert.equal(language("es;q=0.4,gl;q=0.8"), "gl");
  assert.equal(language("gl;q=NaN"), "es");
  assert.equal(language(undefined), "es");
});

test("clock can be controlled without replacing system globals", () => {
  const clock: Clock = { now: () => new Date("2026-10-25T01:30:00Z") };
  assert.equal(clock.now().toISOString(), "2026-10-25T01:30:00.000Z");
});
