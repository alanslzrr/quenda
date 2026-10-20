import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { migrate } from "../../scripts/lib/migrations.ts";
import { buildApp } from "../../src/app.ts";
import { processReservationEmail } from "../../src/modules/communications/index.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";

for (const upgrade of [false, true]) {
  test(`backend HTTP journey including shared quota: ${upgrade ? "upgrade from preceding schema" : "clean database"}`, {
    timeout: 90000,
  }, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "quenda-journey-migrations-"),
    );
    await cp(path.resolve("db/migrations"), directory, { recursive: true });
    const deferred = (await readdir(directory))
      .filter((name) => name.endsWith(".sql") && name >= "0059_")
      .sort();
    assert.ok(deferred.includes("0059_reservation_read_audit.sql"));
    if (upgrade)
      for (const filename of deferred) await rm(path.join(directory, filename));
    try {
      await withDatabase(async ({ auth, domain, migration, worker }) => {
        const messages: MailMessage[] = [];
        const mail = {
          send: async (message: MailMessage) => {
            messages.push(message);
          },
        };
        const config = {
          origin: "https://quenda.test",
          secret: randomBytes(32).toString("hex"),
        };
        const app = await buildApp({
          database: { check: async () => {}, close: async () => {} },
          domain,
          logLevel: "silent",
          identity: {
            authentication: createAuthentication(auth, config, mail),
            config,
          },
        });
        const ok = (
          response: Awaited<ReturnType<ReturnType<typeof browser>["request"]>>,
          expected = 200,
        ) => {
          assert.equal(response.statusCode, expected, response.body);
          return response.json();
        };
        try {
          const register = async (
            name: string,
            address: string,
            mfa: boolean,
          ) => {
            const client = browser(app, address),
              email = `${name}@example.test`,
              password = "Synthetic-journey-password-123!";
            const user = ok(
              await client.request("/api/auth/sign-up/email", {
                name,
                email,
                password,
              }),
            ).user;
            const message = messages.find(
              (item) => item.to === email && item.text.includes("verify-email"),
            );
            assert.ok(message);
            const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
            assert.ok(
              [200, 302].includes(
                (await client.request(link.pathname + link.search)).statusCode,
              ),
            );
            ok(
              await client.request("/api/auth/sign-in/email", {
                email,
                password,
              }),
            );
            if (mfa) {
              const enrolled = ok(
                await client.request("/api/auth/two-factor/enable", {
                  password,
                }),
              );
              const secret = new URL(enrolled.totpURI).searchParams.get(
                "secret",
              );
              assert.ok(secret);
              ok(
                await client.request("/api/auth/two-factor/verify-totp", {
                  code: totp(secret),
                }),
              );
            }
            return { client, id: user.id as string };
          };
          const operator = await register("operator", "192.0.2.201", true);
          const admin = await register("administrator", "192.0.2.202", true);
          const citizen = await register("citizen", "192.0.2.203", false);
          // Sole administrative bootstrap; all product data and user actions use HTTP.
          const owner = new Client({
            connectionString: migration.options.connectionString,
          });
          await owner.connect();
          try {
            await initializeOperator(owner, operator.id);
          } finally {
            await owner.end();
          }
          const setupMunicipality = async (
            admin: Awaited<ReturnType<typeof register>>,
          ) => {
            const municipality = ok(
              await operator.client.request("/api/municipalities", {
                name: "Journey municipality",
                timezone: "Europe/Madrid",
                administratorId: admin.id,
                invitationExpiresAt: new Date(
                  Date.now() + 3600000,
                ).toISOString(),
              }),
              201,
            );
            const base = `/api/municipalities/${municipality.tenantId}`;
            ok(
              await admin.client.request(
                `${base}/administrator-invitations/${municipality.invitationId}/accept`,
                {},
              ),
            );
            const facility = ok(
              await admin.client.request(`${base}/facilities`, {
                name: "Journey facility",
              }),
              201,
            );
            const unit = ok(
              await admin.client.request(
                `${base}/facilities/${facility.facilityId}/units`,
                { name: "Journey court" },
              ),
              201,
            );
            ok(
              await app.inject({
                method: "PUT",
                url: `${base}/units/${unit.unitId}/calendar`,
                headers: {
                  origin: config.origin,
                  cookie: admin.client.cookie(),
                },
                payload: {
                  expectedVersion: 0,
                  reason: "Initial availability",
                  calendar: {
                    minimumMinutes: 60,
                    maximumMinutes: 120,
                    stepMinutes: 60,
                    advanceDays: null,
                    weekly: Array.from({ length: 7 }, (_, i) => ({
                      day: i + 1,
                      startMinute: 0,
                      endMinute: 1440,
                    })),
                    exceptions: [],
                  },
                },
              }),
            );
            ok(
              await admin.client.request(
                `${base}/facilities/${facility.facilityId}/publish`,
                { reason: "Open facility" },
              ),
            );
            ok(
              await admin.client.request(
                `${base}/units/${unit.unitId}/publish`,
                {
                  reason: "Open independent court",
                  calendarVersion: 1,
                  independenceConfirmed: true,
                },
              ),
            );
            return { municipality, base, unit };
          };
          const { municipality, base, unit } = await setupMunicipality(admin);
          const start = new Date();
          start.setUTCDate(start.getUTCDate() + 2);
          start.setUTCHours(10, 0, 0, 0);
          const availability = `/api/public/municipalities/${municipality.tenantId}/units/${unit.unitId}/availability?date=${start.toISOString().slice(0, 10)}&durationMinutes=60`;
          const available = async () =>
            ok(await citizen.client.request(availability)).slots.map(
              (slot: { start: { utc: string } }) => slot.start.utc,
            ) as string[];
          assert.ok((await available()).includes(start.toISOString()));
          const input = {
            unitId: unit.unitId,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + 3600000).toISOString(),
          };
          const created = ok(
            await citizen.client.request(`${base}/reservations`, input, {
              "idempotency-key": "journey-create",
            }),
            201,
          );
          assert.ok(!(await available()).includes(input.startsAt));
          const reservation = `${base}/reservations/${created.id}`;
          assert.equal(
            ok(await citizen.client.request(reservation)).status,
            "CONFIRMADA",
          );
          const changed = ok(
            await citizen.client.request(
              `${reservation}/modify`,
              {
                ...input,
                startsAt: new Date(start.getTime() + 3600000).toISOString(),
                endsAt: new Date(start.getTime() + 7200000).toISOString(),
                expectedRevision: 1,
              },
              { "idempotency-key": "journey-modify" },
            ),
          );
          assert.equal(changed.revision, 2);
          const afterChange = await available();
          assert.ok(afterChange.includes(input.startsAt));
          assert.ok(!afterChange.includes(changed.startsAt));
          const cancelled = ok(
            await citizen.client.request(
              `${reservation}/cancel`,
              { expectedRevision: 2 },
              { "idempotency-key": "journey-cancel" },
            ),
          );
          assert.equal(cancelled.status, "CANCELADA");
          assert.equal(cancelled.revision, 3);
          assert.ok((await available()).includes(changed.startsAt));
          const from = start.toISOString().slice(0, 10),
            to = new Date(start.getTime() + 86400000)
              .toISOString()
              .slice(0, 10);
          if (upgrade) {
            const upgradeClient = new Client({
              connectionString: migration.options.connectionString,
            });
            await upgradeClient.connect();
            try {
              assert.equal(
                (
                  await upgradeClient.query(
                    "SELECT to_regclass('domain.reservation_read_event') AS relation",
                  )
                ).rows[0].relation,
                null,
              );
              assert.deepEqual(
                await migrate(upgradeClient, path.resolve("db/migrations")),
                deferred,
              );
              assert.deepEqual(
                await migrate(upgradeClient, path.resolve("db/migrations")),
                [],
              );
            } finally {
              await upgradeClient.end();
            }
          }
          const administrativeRead = ok(
            await admin.client.request(reservation),
          );
          assert.equal(administrativeRead.id, created.id);
          assert.equal(administrativeRead.status, "CANCELADA");
          assert.equal(administrativeRead.revision, 3);
          const exported = ok(
            await admin.client.request(
              `${base}/exports/reservations?from=${from}&to=${to}`,
            ),
          );
          assert.equal(exported.reservations.length, 1);
          assert.equal(exported.reservations[0].id, created.id);
          assert.equal(exported.reservations[0].status, "CANCELADA");
          const notices = ok(await citizen.client.request("/api/me/notices"));
          assert.equal(notices.items.length, 3);
          assert.deepEqual(
            notices.items.map((notice: { kind: string }) => notice.kind).sort(),
            ["CANCELADA", "CONFIRMADA", "MODIFICADA"],
          );
          const beforeMail = messages.length;
          for (let i = 0; i < 3; i++)
            await processReservationEmail(worker, mail, {
              origin: config.origin,
              locale: "es",
              leaseSeconds: 30,
              maxAttempts: 3,
              retrySeconds: 1,
            });
          assert.equal(messages.length - beforeMail, 3);
          assert.ok(
            messages
              .slice(beforeMail)
              .every((item) => item.to === "citizen@example.test"),
          );
          assert.equal(
            (await operator.client.request(reservation)).statusCode,
            404,
          );
          const secondAdmin = await register(
            "second-administrator",
            "192.0.2.204",
            true,
          );
          const second = await setupMunicipality(secondAdmin);
          const agreement = ok(
            await admin.client.request(
              `${base}/agreements`,
              {
                name: "Joint journey programme",
                timeZone: "Europe/Madrid",
                startsAt: new Date(Date.now() - 60000).toISOString(),
                endsAt: new Date(start.getTime() + 7 * 86400000).toISOString(),
                purpose: "Shared sports access",
                legalBasis: "Synthetic acceptance reference",
                responsibilities: "Each municipality manages its units",
                retentionPolicy: "Synthetic acceptance policy",
                eligibility: "acceso_abierto",
                weeklyLimit: 1,
                aggregateReports: false,
                participants: [
                  {
                    tenantId: municipality.tenantId,
                    accreditationIssuer: false,
                    unitIds: [unit.unitId],
                  },
                  {
                    tenantId: second.municipality.tenantId,
                    accreditationIssuer: false,
                    unitIds: [second.unit.unitId],
                  },
                ],
              },
              { "idempotency-key": "journey-agreement" },
            ),
            201,
          );
          const agreementPath = `${base}/agreements/${agreement.agreementId}`;
          ok(
            await admin.client.request(
              `${agreementPath}/approve`,
              { version: 1, unitIds: [unit.unitId] },
              { "idempotency-key": "journey-approve-first" },
            ),
          );
          assert.equal(
            (
              await admin.client.request(
                `${agreementPath}/activate`,
                {
                  version: 1,
                  legalReviewReference: "Synthetic acceptance review",
                  reportReviewReference: null,
                },
                { "idempotency-key": "journey-premature-activation" },
              )
            ).statusCode,
            409,
          );
          ok(
            await secondAdmin.client.request(
              `${second.base}/agreements/${agreement.agreementId}/approve`,
              { version: 1, unitIds: [second.unit.unitId] },
              { "idempotency-key": "journey-approve-second" },
            ),
          );
          assert.equal(
            ok(
              await admin.client.request(
                `${agreementPath}/activate`,
                {
                  version: 1,
                  legalReviewReference: "Synthetic acceptance review",
                  reportReviewReference: null,
                },
                { "idempotency-key": "journey-activate" },
              ),
            ).status,
            "ACTIVADO",
          );
          const firstQuota = ok(
            await citizen.client.request(`${base}/reservations`, input, {
              "idempotency-key": "journey-quota-first",
            }),
            201,
          );
          const secondInput = { ...input, unitId: second.unit.unitId };
          assert.equal(
            (
              await citizen.client.request(
                `${second.base}/reservations`,
                secondInput,
                { "idempotency-key": "journey-quota-full" },
              )
            ).statusCode,
            409,
          );
          ok(
            await citizen.client.request(
              `${base}/reservations/${firstQuota.id}/cancel`,
              { expectedRevision: 1 },
              { "idempotency-key": "journey-free-quota" },
            ),
          );
          const secondQuota = ok(
            await citizen.client.request(
              `${second.base}/reservations`,
              secondInput,
              { "idempotency-key": "journey-quota-reused" },
            ),
            201,
          );
          assert.equal(secondQuota.status, "CONFIRMADA");
          assert.equal(
            (
              await admin.client.request(
                `${second.base}/reservations/${secondQuota.id}`,
              )
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await secondAdmin.client.request(
                `${base}/reservations/${firstQuota.id}`,
              )
            ).statusCode,
            404,
          );
          const own = ok(await citizen.client.request("/api/me/reservations"));
          assert.equal(own.items.length, 3);
          assert.equal(
            own.items.filter(
              (item: { status: string }) => item.status === "CONFIRMADA",
            ).length,
            1,
          );
          const secondExport = ok(
            await secondAdmin.client.request(
              `${second.base}/exports/reservations?from=${from}&to=${to}`,
            ),
          );
          assert.deepEqual(
            secondExport.reservations.map((item: { id: string }) => item.id),
            [secondQuota.id],
          );
          assert.equal(
            ok(await citizen.client.request("/api/me/notices")).items.length,
            6,
          );
          const sharedMail = messages.length;
          for (let i = 0; i < 3; i++)
            await processReservationEmail(worker, mail, {
              origin: config.origin,
              locale: "es",
              leaseSeconds: 30,
              maxAttempts: 3,
              retrySeconds: 1,
            });
          assert.equal(messages.length - sharedMail, 3);
          assert.ok(
            messages
              .slice(sharedMail)
              .every((item) => item.to === "citizen@example.test"),
          );
        } finally {
          await app.close();
        }
      }, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
