import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { transaction } from "../../src/database/transaction.ts";
import { reservationExportSchema } from "../../src/modules/communications/export-schema.ts";
import {
  listOwnNotices,
  processReservationEmail,
} from "../../src/modules/communications/index.ts";
import { exportReservations } from "../../src/modules/communications/reservation-export.ts";
import {
  cancelReservation,
  createReservation,
  modifyReservation,
} from "../../src/modules/reservations/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("relocation communications separate accepted rules from pending rules and preserve event history", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, migration, domain, worker }) => {
    const tenantId = randomUUID(),
      facilityId = randomUUID(),
      originalUnit = randomUUID(),
      destinationUnit = randomUUID(),
      invitationId = randomUUID();
    const holder = {
      accountId: "relocation-holder",
      email: "holder@example.test",
      sessionId: "holder-session",
      mfaVerifiedAt: null,
    };
    const administrator = {
      accountId: "relocation-admin",
      email: "admin@example.test",
      sessionId: "admin-session",
      mfaVerifiedAt: new Date(),
    };
    const outsider = {
      accountId: "relocation-outsider",
      sessionId: "outsider-session",
      mfaVerifiedAt: null,
      email: "outsider@example.test",
    };
    for (const actor of [holder, administrator, outsider])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$1,$2,true,$3)',
        [
          actor.accountId,
          actor.email,
          actor.accountId === administrator.accountId,
        ],
      );
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Communications','UTC')",
      [tenantId],
    );
    await migration.query(
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
      [tenantId, administrator.accountId],
    );
    await migration.query(
      "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
      [tenantId, invitationId, administrator.accountId],
    );
    await migration.query(
      "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
      [tenantId, administrator.accountId, invitationId],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Sports',now())",
      [tenantId, facilityId],
    );
    for (const unitId of [originalUnit, destinationUnit]) {
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Court')",
        [tenantId, unitId, facilityId],
      );
      await migration.query(
        "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,60,60,60,$3,'[]',$4,'Fixture')",
        [
          tenantId,
          unitId,
          JSON.stringify(
            Array.from({ length: 7 }, (_, index) => ({
              day: index + 1,
              startMinute: 0,
              endMinute: 1440,
            })),
          ),
          administrator.accountId,
        ],
      );
      await migration.query(
        "INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id) VALUES($1,$2,1,$3,$4,'Fixture',$5)",
        [
          tenantId,
          unitId,
          unitId === originalUnit
            ? "Original unit accepted rules"
            : "Destination unit pending rules",
          administrator.accountId,
          randomUUID(),
        ],
      );
      await migration.query(
        "UPDATE domain.reservable_unit SET calendar_version=1,usage_rules_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, unitId],
      );
    }
    const start = new Date(
      Math.ceil(Date.now() / 3600000) * 3600000 + 48 * 3600000,
    );
    const interval = {
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600000).toISOString(),
    };
    const created = (
      await createReservation(
        domain,
        holder,
        tenantId,
        "create-for-relocation",
        {
          ...interval,
          unitId: originalUnit,
          acceptance: {
            usageRulesVersion: 1,
            bookingPolicyVersion: 1,
            nonCancellable: false,
          },
        },
        randomUUID(),
        3600,
      )
    ).result;
    await modifyReservation(
      domain,
      administrator,
      tenantId,
      created.id,
      "relocate-for-notice",
      {
        ...interval,
        unitId: destinationUnit,
        expectedRevision: 1,
        administrative: true,
        reason: "Original court unavailable",
      },
      randomUUID(),
      3600,
    );
    const notice = (await listOwnNotices(domain, holder)).items.find(
      (item) => item.kind === "MODIFICADA",
    );
    assert.ok(notice);
    assert.equal(notice.unitId, destinationUnit);
    assert.equal(notice.pendingUsageRulesVersion, 1);
    assert.equal(Object.hasOwn(notice, "rulesAcceptedAt"), false);
    assert.equal(notice.administrative, true);
    assert.equal(notice.actorName, administrator.accountId);
    assert.equal(notice.reason, "Original court unavailable");
    await auth.query('UPDATE auth."user" SET name=$2 WHERE id=$1', [
      administrator.accountId,
      "Renamed administrator",
    ]);
    const historicalNotice = (await listOwnNotices(domain, holder)).items.find(
      (item) => item.eventId === notice.eventId,
    );
    assert.equal(historicalNotice?.actorName, administrator.accountId);
    assert.deepEqual((await listOwnNotices(domain, outsider)).items, []);
    for (const [functionName, expectedText] of [
      ["accepted_usage_rules", "Original unit accepted rules"],
      ["pending_usage_rules", "Destination unit pending rules"],
    ]) {
      const sql = `SELECT domain.${functionName}($1) AS content`;
      assert.equal(
        (
          await transaction(
            domain,
            (client) => client.query(sql, [created.id]),
            { accountId: holder.accountId, tenantId },
          )
        ).rows[0].content,
        expectedText,
      );
      for (const context of [
        { accountId: outsider.accountId, tenantId },
        { accountId: holder.accountId, tenantId: randomUUID() },
      ])
        await assert.rejects(
          transaction(
            domain,
            (client) => client.query(sql, [created.id]),
            context,
          ),
          { code: "42501" },
        );
      await assert.rejects(worker.query(sql, [created.id]), {
        code: "42501",
      });
    }

    const from = interval.startsAt.slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    const document = JSON.parse(
      JSON.stringify(
        await exportReservations(domain, administrator, tenantId, from, to),
      ),
    );
    const validator = new Ajv({ strict: false, allErrors: true });
    addFormats.default(validator);
    const valid = validator.compile<{
      version: number;
      reservations: Record<string, unknown>[];
    }>(reservationExportSchema);
    assert.ok(valid(document), validator.errorsText(valid.errors));
    assert.equal(document.version, 3);
    assert.equal(document.reservations.length, 1);
    const exported = document.reservations[0];
    assert.ok(exported);
    assert.equal(exported.unitId, destinationUnit);
    assert.equal(exported.usageRulesUnitId, originalUnit);
    assert.equal(exported.usageRulesVersion, 1);
    assert.equal(exported.usageRulesText, "Original unit accepted rules");
    assert.equal(typeof exported.rulesAcceptedAt, "string");
    assert.ok(created.rulesAcceptedAt);
    assert.equal(
      Date.parse(exported.rulesAcceptedAt as string),
      Date.parse(created.rulesAcceptedAt),
    );
    assert.equal(exported.pendingUsageRulesVersion, 1);
    assert.equal(
      exported.pendingUsageRulesText,
      "Destination unit pending rules",
    );

    // Neither later publication nor cancellation rewrites an earlier notice.
    await migration.query(
      "INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id) VALUES($1,$2,2,'Later destination rules',$3,'Later publication',$4)",
      [tenantId, destinationUnit, administrator.accountId, randomUUID()],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET usage_rules_version=2 WHERE tenant_id=$1 AND id=$2",
      [tenantId, destinationUnit],
    );
    await cancelReservation(
      domain,
      holder,
      tenantId,
      created.id,
      "cancel-pending-rules",
      { expectedRevision: 2 },
      randomUUID(),
      3600,
    );
    const historical = (await listOwnNotices(domain, holder)).items.find(
      (item) => item.eventId === notice.eventId,
    );
    assert.deepEqual(historical, notice);

    const messages: MailMessage[] = [];
    const transport = {
      send: async (message: MailMessage) => {
        messages.push(message);
      },
    };
    const options = {
      origin: "https://quenda.test",
      locale: "es" as const,
      leaseSeconds: 30,
      maxAttempts: 3,
      retrySeconds: 60,
    };
    for (let count = 0; count < 3; count++)
      assert.equal(
        await processReservationEmail(worker, transport, options),
        "ACCEPTED",
      );
    assert.equal(
      await processReservationEmail(worker, transport, options),
      "IDLE",
    );
    assert.deepEqual(
      messages.map((message) => message.subject),
      [
        "Quenda — Reserva confirmada",
        "Quenda — Reserva modificada",
        "Quenda — Reserva cancelada",
      ],
    );
    assert.ok(messages.every((message) => message.to === holder.email));
    const modified = messages[1];
    assert.match(modified?.text ?? "", /relocation-admin/);
    assert.match(modified?.text ?? "", /Original court unavailable/);
    assert.doesNotMatch(modified?.text ?? "", /Renamed administrator/);
    assert.ok(modified);
    assert.match(modified.text, /Normas pendientes de aceptación/);
    // The pending rules name the destination space, not its identifier.
    const destinationName = (
      await migration.query(
        "SELECT name FROM domain.reservable_unit WHERE id=$1",
        [destinationUnit],
      )
    ).rows[0]?.name;
    assert.ok(destinationName);
    assert.ok(
      modified.text.includes(`Espacio de las normas: ${destinationName}`),
    );
    assert.ok(!modified.text.includes(destinationUnit));
    assert.match(modified.text, /Versión de las normas: 1/);
    assert.doesNotMatch(modified.text, /Versión de las normas: 2/);
    assert.ok(!modified.text.includes(originalUnit));
    assert.doesNotMatch(
      messages[2]?.text ?? "",
      /Normas pendientes de aceptación/,
    );
  });
});
