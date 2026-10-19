import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../../src/config.ts";
import { readMailConfiguration } from "../../src/mail/config.ts";

test("mail configuration requires TLS and permits production only with SMTP", () => {
  const smtp = {
    MAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_FROM: "quenda@example.test",
    NODE_ENV: "production",
  };
  assert.equal(readMailConfiguration(smtp).kind, "smtp");
  assert.equal(readMailConfiguration({}).kind, "local");
  for (const patch of [
    { MAIL_TRANSPORT: "local" },
    { SMTP_TLS: "none" },
    { SMTP_PORT: "0" },
    { SMTP_USER: "user" },
    { SMTP_FROM: "bad\r\nBcc: other" },
    { SMTP_HOST: "" },
  ])
    assert.throws(() => readMailConfiguration({ ...smtp, ...patch }));
  const config = readConfig({
    ...smtp,
    AUTH_ORIGIN: "https://quenda.test",
    AUTH_SECRET: "synthetic-secret-32-characters-long",
    DOMAIN_DATABASE_URL: "postgresql://domain:secret@localhost/quenda",
    AUTH_DATABASE_URL: "postgresql://auth:secret@localhost/quenda",
  });
  assert.equal(config.mail.kind, "smtp");
});
