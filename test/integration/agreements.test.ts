import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import {
  type AgreementDraftInput,
  approveAgreement,
  createAgreementDraft,
} from "../../src/modules/collaboration/index.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("agreement drafts preserve participant ownership and do not activate capabilities", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const tenants = [randomUUID(), randomUUID(), randomUUID()];
    const units = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      const accountId = `admin-${i}`,
        tenant = tenants[i],
        unit = units[i],
        invitation = randomUUID(),
        facility = randomUUID();
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [accountId, `${accountId}@example.test`],
      );
      await migration.query(
        "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
        [tenant],
      );
      await migration.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2)",
        [tenant, accountId],
      );
      await migration.query(
        "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
        [tenant, invitation, accountId],
      );
      await migration.query(
        "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
        [tenant, accountId, invitation],
      );
      await migration.query(
        "INSERT INTO domain.facility(tenant_id,id,name) VALUES($1,$2,'Facility')",
        [tenant, facility],
      );
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
        [tenant, unit, facility],
      );
    }
    const tenant = tenants[0] as string;
    const actor = (i: number) => ({
      accountId: `admin-${i}`,
      email: `admin-${i}@example.test`,
      sessionId: `verified-${i}`,
      mfaVerifiedAt: new Date(),
    });
    const input: AgreementDraftInput = {
      name: "Joint sports programme",
      timeZone: "Europe/Madrid",
      startsAt: "2030-01-01T00:00:00Z",
      endsAt: "2031-01-01T00:00:00Z",
      purpose: "Shared access",
      legalBasis: "Synthetic legal reference",
      responsibilities: "Each municipality manages its resources",
      retentionPolicy: "Synthetic retention policy",
      eligibility: "acreditacion_vigente",
      weeklyLimit: 3,
      aggregateReports: false,
      participants: [0, 1].map((i) => ({
        tenantId: tenants[i] as string,
        accreditationIssuer: true,
        unitIds: [units[i] as string],
      })),
    };
    const correlationId = randomUUID();
    const create = (key: string, data = input, requestId = correlationId) =>
      createAgreementDraft(
        domain,
        actor(0),
        tenant,
        key,
        data,
        requestId,
        3600,
      );
    let agreement = "";
    await t.test(
      "requires a participating administrator with recent MFA and rejects cross-owner references atomically",
      async () => {
        await assert.rejects(
          createAgreementDraft(
            domain,
            { ...actor(0), mfaVerifiedAt: null },
            tenant,
            "no-mfa",
            input,
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          createAgreementDraft(
            domain,
            actor(2),
            tenant,
            "other-admin",
            input,
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          create("creator-absent", {
            ...input,
            participants: input.participants.slice(1),
          }),
          { code: "INVALID_INPUT" },
        );
        const invalid = {
          ...input,
          participants: input.participants.map((p, i) => ({
            ...p,
            unitIds: [units[1 - i] as string],
          })),
        };
        await assert.rejects(create("foreign-unit", invalid), {
          code: "NOT_FOUND",
        });
        for (const table of [
          "agreement",
          "agreement_version",
          "agreement_participant",
          "agreement_unit",
          "idempotent_command",
        ])
          assert.equal(
            (
              await migration.query(
                `SELECT count(*)::int AS n FROM domain.${table}`,
              )
            ).rows[0].n,
            0,
          );
      },
    );
    await t.test(
      "creates a single idempotent draft with canonical participants and no activated version",
      async () => {
        const saved = await create("draft");
        agreement = saved.result.agreementId;
        assert.equal(saved.result.status, "BORRADOR");
        assert.equal(saved.result.version, 1);
        const replay = await create(
          "draft",
          { ...input, participants: [...input.participants].reverse() },
          randomUUID(),
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, saved.result);
        await assert.rejects(create("draft", { ...input, weeklyLimit: 4 }), {
          code: "CONFLICT",
        });
        const state = (
          await migration.query(
            "SELECT status,weekly_limit,legal_review_reference,created_by,correlation_id FROM domain.agreement_version WHERE agreement_id=$1",
            [agreement],
          )
        ).rows[0];
        assert.deepEqual(state, {
          status: "BORRADOR",
          weekly_limit: 3,
          legal_review_reference: null,
          created_by: actor(0).accountId,
          correlation_id: correlationId,
        });
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_unit",
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "participants see only their agreement versions; other administrators and absent context see nothing",
      async () => {
        for (let i = 0; i < 3; i++)
          await transaction(
            domain,
            async (c) => {
              for (const table of [
                "agreement",
                "agreement_version",
                "agreement_participant",
                "agreement_unit",
              ]) {
                const found = await c.query(`SELECT * FROM domain.${table}`);
                assert.equal(
                  found.rowCount,
                  i === 2
                    ? 0
                    : table === "agreement_participant" ||
                        table === "agreement_unit"
                      ? 2
                      : 1,
                  table,
                );
              }
            },
            { accountId: actor(i).accountId, tenantId: tenants[i] as string },
          );
        assert.equal(
          (await domain.query("SELECT * FROM domain.agreement")).rowCount,
          0,
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                "UPDATE domain.agreement SET timezone='UTC' WHERE id=$1",
                [agreement],
              ),
            { accountId: actor(0).accountId, tenantId: tenant },
          ),
          { code: "42501" },
        );
        await assert.rejects(
          transaction(
            domain,
            (c) =>
              c.query(
                "UPDATE domain.agreement_version SET status='ACTIVADO' WHERE agreement_id=$1",
                [agreement],
              ),
            { accountId: actor(0).accountId, tenantId: tenant },
          ),
          { code: "42501" },
        );
      },
    );
    const approve = (
      i: number,
      key: string,
      id = agreement,
      unitIds = [units[i] as string],
    ) =>
      approveAgreement(
        domain,
        actor(i),
        tenants[i] as string,
        id,
        key,
        { version: 1, unitIds },
        randomUUID(),
        3600,
      );
    await t.test(
      "approvals require each participant's exact units and never activate the version",
      async () => {
        await assert.rejects(approve(2, "outsider"), { code: "NOT_FOUND" });
        await assert.rejects(approve(0, "missing-unit", agreement, []), {
          code: "CONFLICT",
        });
        await assert.rejects(
          approve(0, "foreign-unit", agreement, [units[1] as string]),
          { code: "CONFLICT" },
        );
        await assert.rejects(
          approveAgreement(
            domain,
            { ...actor(0), mfaVerifiedAt: null },
            tenant,
            agreement,
            "approve-no-mfa",
            { version: 1, unitIds: [units[0] as string] },
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          approveAgreement(
            domain,
            actor(0),
            tenant,
            agreement,
            "unknown-version",
            { version: 2, unitIds: [units[0] as string] },
            randomUUID(),
            3600,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          approveAgreement(
            domain,
            actor(0),
            tenant,
            agreement,
            "duplicate-units",
            { version: 1, unitIds: [units[0] as string, units[0] as string] },
            randomUUID(),
            3600,
          ),
          { code: "INVALID_INPUT" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_approval",
            )
          ).rows[0].n,
          0,
        );
        const first = await approve(0, "approve-a");
        assert.equal(first.result.status, "BORRADOR");
        const evidence = (
          await migration.query("SELECT * FROM domain.agreement_approval")
        ).rows;
        assert.equal(evidence.length, 1);
        assert.equal(evidence[0].approved_by, actor(0).accountId);
        assert.equal(evidence[0].tenant_id, tenant);
        assert.ok(evidence[0].correlation_id);
        assert.equal((await approve(0, "repeat-a")).result.status, "BORRADOR");
        assert.deepEqual(
          (await migration.query("SELECT * FROM domain.agreement_approval"))
            .rows,
          evidence,
        );
        const second = await approve(1, "approve-b");
        assert.equal(second.result.status, "APROBADO");
        assert.equal(
          (
            await migration.query(
              "SELECT status FROM domain.agreement_version WHERE agreement_id=$1",
              [agreement],
            )
          ).rows[0].status,
          "APROBADO",
        );
        const replay = await approve(0, "approve-a");
        assert.equal(replay.replayed, true);
        assert.equal(replay.result.status, "BORRADOR");
        assert.equal(
          (await approve(0, "already-approved")).result.status,
          "APROBADO",
        );
        for (const sql of [
          "UPDATE domain.agreement_approval SET approved_at=now()",
          "DELETE FROM domain.agreement_approval",
        ]) {
          await assert.rejects(
            transaction(domain, (c) => c.query(sql), {
              accountId: actor(0).accountId,
              tenantId: tenant,
            }),
            { code: "42501" },
          );
        }
        await transaction(
          domain,
          async (c) => {
            assert.equal(
              (await c.query("SELECT * FROM domain.agreement_approval"))
                .rowCount,
              0,
            );
          },
          { accountId: actor(2).accountId, tenantId: tenants[2] as string },
        );
      },
    );
    await t.test(
      "concurrent participant approvals converge without losing evidence",
      async () => {
        const draft = await create("concurrent-draft");
        const id = draft.result.agreementId;
        const results = await Promise.all([
          approve(0, "concurrent-a", id),
          approve(1, "concurrent-b", id),
        ]);
        assert.deepEqual(results.map((r) => r.result.status).sort(), [
          "APROBADO",
          "BORRADOR",
        ]);
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_approval WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT status FROM domain.agreement_version WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].status,
          "APROBADO",
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='SUSPENDIDO' WHERE agreement_id=$1",
          [id],
        );
        await assert.rejects(approve(0, "cannot-reapprove", id), {
          code: "CONFLICT",
        });
      },
    );
    await t.test(
      "revoking the creator administrator prevents replay",
      async () => {
        await migration.query(
          "UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=$1 AND account_id='admin-0'",
          [tenant],
        );
        await assert.rejects(create("draft"), { code: "FORBIDDEN" });
        await assert.rejects(approve(0, "approve-a"), { code: "FORBIDDEN" });
      },
    );
  });
});
