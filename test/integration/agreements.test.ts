import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import {
  type AgreementDraftInput,
  activateAgreement,
  approveAgreement,
  createAgreementDraft,
  createAgreementVersion,
  issueAgreementCredential,
  listAgreementVersions,
  readAgreementVersion,
  readUnitAgreementRestriction,
  releaseUnitAgreementRestriction,
  revokeAgreementCredential,
  suspendAgreement,
} from "../../src/modules/collaboration/index.ts";
import { issuedCredentials } from "../../src/modules/collaboration/navigation.ts";
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
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),true)',
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
      "a time zone the database does not list is invalid input",
      async () => {
        await assert.rejects(
          create("lowercase-zone", { ...input, timeZone: "europe/madrid" }),
          { code: "INVALID_INPUT" },
        );
      },
    );
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
          code: "IDEMPOTENCY_KEY_REUSED",
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
          code: "AGREEMENT_STATE_CONFLICT",
        });
        await assert.rejects(
          approve(0, "foreign-unit", agreement, [units[1] as string]),
          { code: "AGREEMENT_STATE_CONFLICT" },
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
          code: "AGREEMENT_STATE_CONFLICT",
        });
      },
    );
    await t.test(
      "new versions preserve evidence but require approvals from their own participants",
      async () => {
        const before = (
          await migration.query(
            "SELECT * FROM domain.agreement_version WHERE agreement_id=$1 AND version=1",
            [agreement],
          )
        ).rows[0];
        const approvals = (
          await migration.query(
            "SELECT * FROM domain.agreement_approval WHERE agreement_id=$1 ORDER BY tenant_id",
            [agreement],
          )
        ).rows;
        const { name: _name, timeZone: _zone, ...configuration } = input;
        const revised = {
          ...configuration,
          expectedVersion: 1,
          weeklyLimit: 2,
          participants: [0, 2].map((i) => ({
            tenantId: tenants[i] as string,
            accreditationIssuer: true,
            unitIds: [units[i] as string],
          })),
        };
        const version = (key: string, data = revised) =>
          createAgreementVersion(
            domain,
            actor(0),
            tenant,
            agreement,
            key,
            data,
            randomUUID(),
            3600,
          );
        await assert.rejects(
          createAgreementVersion(
            domain,
            actor(2),
            tenants[2] as string,
            agreement,
            "outsider-version",
            revised,
            randomUUID(),
            3600,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          createAgreementVersion(
            domain,
            { ...actor(0), mfaVerifiedAt: null },
            tenant,
            agreement,
            "version-no-mfa",
            revised,
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          version("invalid-unit-version", {
            ...revised,
            participants: revised.participants.map((p) => ({
              ...p,
              unitIds: [units[1] as string],
            })),
          }),
          { code: "NOT_FOUND" },
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_version WHERE agreement_id=$1",
              [agreement],
            )
          ).rows[0].n,
          1,
        );
        const saved = await version("version-two");
        assert.deepEqual(saved.result, {
          agreementId: agreement,
          version: 2,
          status: "BORRADOR",
        });
        assert.deepEqual((await version("version-two")).result, saved.result);
        await assert.rejects(version("stale-version"), {
          code: "STALE_VERSION",
        });
        assert.deepEqual(
          (
            await migration.query(
              "SELECT * FROM domain.agreement_version WHERE agreement_id=$1 AND version=1",
              [agreement],
            )
          ).rows[0],
          before,
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT * FROM domain.agreement_approval WHERE agreement_id=$1 ORDER BY tenant_id",
              [agreement],
            )
          ).rows,
          approvals,
        );
        const current = (
          await migration.query(
            "SELECT status,weekly_limit,legal_review_reference,report_review_reference FROM domain.agreement_version WHERE agreement_id=$1 AND version=2",
            [agreement],
          )
        ).rows[0];
        assert.deepEqual(current, {
          status: "BORRADOR",
          weekly_limit: 2,
          legal_review_reference: null,
          report_review_reference: null,
        });
        assert.equal(
          (
            await migration.query(
              "SELECT timezone FROM domain.agreement WHERE id=$1",
              [agreement],
            )
          ).rows[0].timezone,
          input.timeZone,
        );
        await assert.rejects(approve(0, "obsolete-approval"), {
          code: "STALE_VERSION",
        });
        const approveNew = (i: number) =>
          approveAgreement(
            domain,
            actor(i),
            tenants[i] as string,
            agreement,
            "approve-version-two",
            { version: 2, unitIds: [units[i] as string] },
            randomUUID(),
            3600,
          );
        await assert.rejects(approveNew(1), { code: "NOT_FOUND" });
        assert.equal((await approveNew(0)).result.status, "BORRADOR");
        assert.equal((await approveNew(2)).result.status, "APROBADO");
        await transaction(
          domain,
          async (c) => {
            const visible = await c.query(
              "SELECT version FROM domain.agreement_version WHERE agreement_id=$1 ORDER BY version",
              [agreement],
            );
            assert.deepEqual(visible.rows, [{ version: 1 }]);
          },
          { accountId: actor(1).accountId, tenantId: tenants[1] as string },
        );
      },
    );
    await t.test(
      "concurrent edits of the same base version have one winner",
      async () => {
        const id = (await create("versions-race")).result.agreementId;
        const { name: _name, timeZone: _zone, ...configuration } = input;
        const results = await Promise.allSettled(
          [0, 1].map((i) =>
            createAgreementVersion(
              domain,
              actor(i),
              tenants[i] as string,
              id,
              "version-race",
              { ...configuration, expectedVersion: 1, weeklyLimit: 4 + i },
              randomUUID(),
              3600,
            ),
          ),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results)
          if (r.status === "rejected")
            assert.equal(r.reason.code, "STALE_VERSION");
        assert.deepEqual(
          (
            await migration.query(
              "SELECT version,status FROM domain.agreement_version WHERE agreement_id=$1 ORDER BY version",
              [id],
            )
          ).rows,
          [
            { version: 1, status: "BORRADOR" },
            { version: 2, status: "BORRADOR" },
          ],
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_approval WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "an approval racing with a new version never approves the new configuration",
      async () => {
        const id = (await create("approval-edit-race")).result.agreementId;
        const { name: _name, timeZone: _zone, ...configuration } = input;
        const [approval, revision] = await Promise.allSettled([
          approve(1, "approval-edit-race", id),
          createAgreementVersion(
            domain,
            actor(0),
            tenant,
            id,
            "approval-edit-race",
            { ...configuration, expectedVersion: 1, weeklyLimit: 7 },
            randomUUID(),
            3600,
          ),
        ]);
        assert.equal(revision.status, "fulfilled");
        if (approval.status === "rejected")
          assert.equal(approval.reason.code, "STALE_VERSION");
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_approval WHERE agreement_id=$1 AND version=2",
              [id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT status FROM domain.agreement_version WHERE agreement_id=$1 AND version=2",
              [id],
            )
          ).rows[0].status,
          "BORRADOR",
        );
        assert.equal(
          (
            await migration.query(
              "SELECT latest_version FROM domain.agreement WHERE id=$1",
              [id],
            )
          ).rows[0].latest_version,
          2,
        );
        await assert.rejects(approve(1, "approve-obsolete-after-edit", id), {
          code: "STALE_VERSION",
        });
      },
    );
    await t.test(
      "configuration queries paginate after RLS and isolate historical participation",
      async () => {
        const current = await readAgreementVersion(
          domain,
          actor(0),
          tenant,
          agreement,
          2,
        );
        assert.equal(current.status, "APROBADO");
        assert.equal(current.weeklyLimit, 2);
        assert.equal(current.approvals.length, 2);
        // Each municipality sees who approved for it, and only that it was approved elsewhere.
        assert.equal(
          current.approvals.find((a) => a.tenantId === tenant)?.approvedBy,
          actor(0).accountId,
        );
        assert.ok(
          current.approvals
            .filter((a) => a.tenantId !== tenant)
            .every((a) => a.approvedBy === null && a.approvedByLabel === null),
        );
        assert.ok(
          current.approvals.find((a) => a.tenantId === tenant)?.approvedByLabel
            ?.email,
        );
        assert.equal(current.createdBy, actor(0).accountId);
        assert.equal(
          (
            await readAgreementVersion(
              domain,
              actor(2),
              tenants[2] as string,
              agreement,
              2,
            )
          ).createdBy,
          null,
        );
        assert.deepEqual(
          current.participants.map((p) => p.tenantId).sort(),
          [tenants[0], tenants[2]].sort(),
        );
        assert.equal(current.legalReviewReference, null);
        assert.equal(
          (
            await readAgreementVersion(
              domain,
              actor(1),
              tenants[1] as string,
              agreement,
              1,
            )
          ).weeklyLimit,
          3,
        );
        await assert.rejects(
          readAgreementVersion(
            domain,
            actor(1),
            tenants[1] as string,
            agreement,
            2,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          readAgreementVersion(
            domain,
            actor(2),
            tenants[2] as string,
            agreement,
            1,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          readAgreementVersion(domain, actor(0), tenant, agreement, 999),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          listAgreementVersions(
            domain,
            { ...actor(0), mfaVerifiedAt: null },
            tenant,
          ),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          listAgreementVersions(domain, actor(0), tenant, "invalid"),
          { code: "INVALID_INPUT" },
        );
        for (let i = 0; i < 22; i++) await create(`query-page-${i}`);
        const expected = (
          await migration.query(
            "SELECT agreement_id,version FROM domain.agreement_participant WHERE tenant_id=$1 ORDER BY agreement_id,version",
            [tenant],
          )
        ).rows.map((r) => `${r.agreement_id}:${r.version}`);
        let after: string | null = null;
        const ids: string[] = [];
        do {
          const page = await listAgreementVersions(
            domain,
            actor(0),
            tenant,
            after,
          );
          assert.ok(page.items.length <= 20);
          ids.push(...page.items.map((r) => `${r.agreementId}:${r.version}`));
          after = page.nextCursor;
        } while (after);
        assert.deepEqual(ids, expected);
        assert.equal(new Set(ids).size, ids.length);
        const outsider = await listAgreementVersions(
          domain,
          actor(2),
          tenants[2] as string,
        );
        assert.deepEqual(
          outsider.items.map((r) => [r.agreementId, r.version]),
          [[agreement, 2]],
        );
      },
    );
    await t.test(
      "credentials require an active issuer and local account; revocation preserves evidence",
      async () => {
        const id = (
          await create("credential-draft", {
            ...input,
            startsAt: "2020-01-01T00:00:00Z",
            endsAt: "2040-01-01T00:00:00Z",
          })
        ).result.agreementId;
        const credentialInput = {
          agreementId: id,
          version: 1,
          accountId: actor(0).accountId,
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: "2035-01-01T00:00:00Z",
          verificationReference: "Synthetic verified evidence",
        };
        const issue = (i: number, key: string) =>
          issueAgreementCredential(
            domain,
            actor(i),
            tenants[i] as string,
            key,
            credentialInput,
            randomUUID(),
            3600,
          );
        await assert.rejects(issue(0, "inactive"), {
          code: "AGREEMENT_STATE_CONFLICT",
        });
        await assert.rejects(
          issueAgreementCredential(
            domain,
            actor(0),
            tenant,
            "invalid-credential",
            { ...credentialInput, endsAt: credentialInput.startsAt },
            randomUUID(),
            3600,
          ),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          issueAgreementCredential(
            domain,
            actor(0),
            tenant,
            "no-verification",
            { ...credentialInput, verificationReference: " " },
            randomUUID(),
            3600,
          ),
          { code: "INVALID_INPUT" },
        );
        await assert.rejects(
          issueAgreementCredential(
            domain,
            { ...actor(0), mfaVerifiedAt: null },
            tenant,
            "credential-no-mfa",
            credentialInput,
            randomUUID(),
            3600,
          ),
          { code: "FORBIDDEN" },
        );
        await approve(0, "credential-approve-a", id);
        await approve(1, "credential-approve-b", id);
        await activateAgreement(
          domain,
          actor(0),
          tenant,
          id,
          "credential-activation",
          {
            version: 1,
            legalReviewReference: "Synthetic reviewed agreement",
            reportReviewReference: null,
          },
          randomUUID(),
          3600,
        );
        const originalPeriod = (
          await migration.query(
            "SELECT effective_period::text AS period FROM domain.agreement_activation WHERE agreement_id=$1",
            [id],
          )
        ).rows[0].period;
        for (const period of [
          "empty",
          "[2020-01-01T00:00:00Z,2021-01-01T00:00:00Z)",
          "[2035-01-01T00:00:00Z,2036-01-01T00:00:00Z)",
        ]) {
          await migration.query(
            "UPDATE domain.agreement_activation SET effective_period=$2::tstzrange WHERE agreement_id=$1",
            [id, period],
          );
          await assert.rejects(issue(0, "outside-effective-period"), {
            code: "AGREEMENT_STATE_CONFLICT",
          });
        }
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_credential WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].n,
          0,
        );
        await migration.query(
          "UPDATE domain.agreement_activation SET effective_period=$2::tstzrange WHERE agreement_id=$1",
          [id, originalPeriod],
        );
        await assert.rejects(issue(1, "foreign-account"), {
          code: "NOT_FOUND",
        });
        await assert.rejects(issue(2, "non-participant"), {
          code: "NOT_FOUND",
        });
        await migration.query(
          "UPDATE domain.agreement_version SET eligibility='acceso_abierto' WHERE agreement_id=$1",
          [id],
        );
        await assert.rejects(issue(0, "open-access-mode"), {
          code: "AGREEMENT_STATE_CONFLICT",
        });
        await migration.query(
          "UPDATE domain.agreement_version SET eligibility='acreditacion_vigente' WHERE agreement_id=$1",
          [id],
        );
        await migration.query(
          "UPDATE domain.agreement_participant SET accreditation_issuer=false WHERE agreement_id=$1 AND tenant_id=$2",
          [id, tenant],
        );
        await assert.rejects(issue(0, "not-an-issuer"), { code: "NOT_FOUND" });
        await migration.query(
          "UPDATE domain.agreement_participant SET accreditation_issuer=true WHERE agreement_id=$1 AND tenant_id=$2",
          [id, tenant],
        );
        const saved = await issue(0, "credential-one");
        assert.equal(saved.result.revoked, false);
        const replay = await issue(0, "credential-one");
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, saved.result);
        await issue(0, "credential-two");
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.agreement_subject WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].n,
          1,
        );
        const credential = saved.result.id;
        const issued = await issuedCredentials(domain, actor(0), tenant, null);
        assert.equal(issued.items.length, 2);
        assert.ok(
          issued.items.some(
            (row) =>
              row.id === credential &&
              row.accountLabel?.email ===
                `${credentialInput.accountId}@example.test`,
          ),
        );
        assert.ok(
          issued.items.every(
            (row) => !("verificationReference" in row) && !("subjectId" in row),
          ),
        );
        assert.deepEqual(
          (await issuedCredentials(domain, actor(1), tenants[1]!, null)).items,
          [],
        );
        await assert.rejects(
          issuedCredentials(domain, actor(1), tenant, null),
          { code: "FORBIDDEN" },
        );
        await assert.rejects(
          issuedCredentials(
            domain,
            { ...actor(0), mfaVerifiedAt: new Date(0) },
            tenant,
            null,
          ),
          { code: "REAUTHENTICATION_REQUIRED" },
        );
        await assert.rejects(
          domain.query("SELECT * FROM domain.issued_credentials(NULL)"),
          { code: "42501" },
        );

        const evidence = (
          await migration.query(
            "SELECT * FROM domain.agreement_credential WHERE id=$1",
            [credential],
          )
        ).rows[0];
        assert.equal(evidence.issued_by, actor(0).accountId);
        assert.equal(
          evidence.verification_reference,
          credentialInput.verificationReference,
        );
        await assert.rejects(
          domain.query("SELECT * FROM domain.agreement_credential"),
          { code: "42501" },
        );
        await assert.rejects(
          revokeAgreementCredential(
            domain,
            actor(1),
            tenants[1] as string,
            credential,
            "foreign-revoke",
            "Reason",
            randomUUID(),
            3600,
          ),
          { code: "NOT_FOUND" },
        );
        await suspendAgreement(
          domain,
          actor(0),
          tenant,
          id,
          "credential-suspension",
          { version: 1, reason: "Synthetic review" },
          randomUUID(),
          3600,
        );
        await assert.rejects(issue(0, "suspended-issue"), {
          code: "AGREEMENT_STATE_CONFLICT",
        });
        const revoked = await revokeAgreementCredential(
          domain,
          actor(0),
          tenant,
          credential,
          "revoke",
          "Verification withdrawn",
          randomUUID(),
          3600,
        );
        assert.equal(revoked.result.revoked, true);
        const after = (
          await migration.query(
            "SELECT * FROM domain.agreement_credential WHERE id=$1",
            [credential],
          )
        ).rows[0];
        assert.ok(after.revoked_at);
        assert.equal(after.revoked_by, actor(0).accountId);
        assert.equal(
          after.verification_reference,
          evidence.verification_reference,
        );
        assert.equal(after.correlation_id, evidence.correlation_id);
        await revokeAgreementCredential(
          domain,
          actor(0),
          tenant,
          credential,
          "revoke-again",
          "Another reason",
          randomUUID(),
          3600,
        );
        assert.deepEqual(
          (
            await migration.query(
              "SELECT * FROM domain.agreement_credential WHERE id=$1",
              [credential],
            )
          ).rows[0],
          after,
        );
      },
    );
    await t.test(
      "a participant suspends a scheduled activation without deleting its gate",
      async () => {
        const id = (await create("scheduled-suspension")).result.agreementId;
        const reason = { version: 1, reason: "Review before opening" };
        await assert.rejects(
          suspendAgreement(
            domain,
            actor(0),
            tenant,
            id,
            "draft-suspend",
            reason,
            randomUUID(),
            3600,
          ),
          { code: "AGREEMENT_STATE_CONFLICT" },
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='ACTIVADO' WHERE agreement_id=$1",
          [id],
        );
        await migration.query(
          "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,1,'[2030-01-01T00:00:00Z,2031-01-01T00:00:00Z)','admin-0',$2)",
          [id, randomUUID()],
        );
        await migration.query(
          "INSERT INTO domain.agreement_assignment SELECT agreement_id,version,tenant_id,unit_id,'[2030-01-01T00:00:00Z,2031-01-01T00:00:00Z)'::tstzrange FROM domain.agreement_unit WHERE agreement_id=$1",
          [id],
        );
        await migration.query(
          "INSERT INTO domain.unit_agreement_gate(tenant_id,unit_id,agreement_id,version) SELECT tenant_id,unit_id,agreement_id,version FROM domain.agreement_unit WHERE agreement_id=$1 ON CONFLICT(tenant_id,unit_id) DO UPDATE SET agreement_id=EXCLUDED.agreement_id,version=EXCLUDED.version",
          [id],
        );
        assert.equal(
          (
            await readUnitAgreementRestriction(
              domain,
              actor(0),
              tenant,
              units[0] as string,
            )
          ).restriction?.hasRemainingAssignment,
          true,
        );
        await assert.rejects(
          releaseUnitAgreementRestriction(
            domain,
            actor(0),
            tenant,
            units[0] as string,
            "scheduled-release",
            {
              expectedAgreementId: id,
              expectedVersion: 1,
              reason: "Premature reopening",
            },
            randomUUID(),
            3600,
          ),
          { code: "CONFLICT" },
        );
        await assert.rejects(
          readUnitAgreementRestriction(
            domain,
            actor(2),
            tenants[2] as string,
            units[0] as string,
          ),
          { code: "NOT_FOUND" },
        );
        await assert.rejects(
          domain.query("DELETE FROM domain.unit_agreement_release_event"),
          { code: "42501" },
        );
        await assert.rejects(
          suspendAgreement(
            domain,
            actor(2),
            tenants[2] as string,
            id,
            "outsider-suspend",
            reason,
            randomUUID(),
            3600,
          ),
          { code: "NOT_FOUND" },
        );
        await suspendAgreement(
          domain,
          actor(1),
          tenants[1] as string,
          id,
          "participant-suspend",
          reason,
          randomUUID(),
          3600,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT isempty(effective_period) AS closed FROM domain.agreement_activation WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].closed,
          true,
        );
        assert.equal(
          (
            await migration.query(
              "SELECT count(*)::int AS n FROM domain.unit_agreement_gate WHERE agreement_id=$1",
              [id],
            )
          ).rows[0].n,
          2,
        );
        await assert.rejects(
          domain.query("DELETE FROM domain.agreement_lifecycle_event"),
          { code: "42501" },
        );
        await transaction(
          domain,
          async (c) => {
            assert.equal(
              (
                await c.query(
                  "SELECT * FROM domain.agreement_lifecycle_event WHERE agreement_id=$1",
                  [id],
                )
              ).rowCount,
              0,
            );
          },
          { accountId: actor(2).accountId, tenantId: tenants[2] as string },
        );
      },
    );
    await t.test(
      "a participant of a replaced version cannot suspend the version in force",
      async () => {
        const started = {
          ...input,
          startsAt: new Date(Date.now() - 86_400_000).toISOString(),
        };
        const id = (await create("replaced-suspension", started)).result
          .agreementId;
        const { name: _name, timeZone: _zone, ...configuration } = started;
        await createAgreementVersion(
          domain,
          actor(0),
          tenant,
          id,
          "replacement-version",
          {
            ...configuration,
            expectedVersion: 1,
            participants: [0, 2].map((i) => ({
              tenantId: tenants[i] as string,
              accreditationIssuer: true,
              unitIds: [units[i] as string],
            })),
          },
          randomUUID(),
          3600,
        );
        await migration.query(
          "UPDATE domain.agreement_version SET status='ACTIVADO' WHERE agreement_id=$1",
          [id],
        );
        await migration.query(
          `INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id)
          VALUES($1,1,tstzrange(now()-interval '2 hours',now()-interval '1 hour','[)'),'admin-0',$2),
           ($1,2,tstzrange(now()-interval '1 hour',now()+interval '1 day','[)'),'admin-0',$2)`,
          [id, randomUUID()],
        );
        const suspend = (i: number, version: number, key: string) =>
          suspendAgreement(
            domain,
            actor(i),
            tenants[i] as string,
            id,
            key,
            { version, reason: "Review" },
            randomUUID(),
            3600,
          );
        const state = async () =>
          (
            await migration.query(
              `SELECT v.version,v.status,upper(a.effective_period)>now() AS open
              FROM domain.agreement_version v JOIN domain.agreement_activation a USING(agreement_id,version)
              WHERE v.agreement_id=$1 ORDER BY v.version`,
              [id],
            )
          ).rows;
        await assert.rejects(suspend(1, 1, "former-participant"), {
          code: "AGREEMENT_STATE_CONFLICT",
        });
        await assert.rejects(suspend(1, 2, "former-participant-current"), {
          code: "NOT_FOUND",
        });
        assert.deepEqual(await state(), [
          { version: 1, status: "ACTIVADO", open: false },
          { version: 2, status: "ACTIVADO", open: true },
        ]);
        await suspend(2, 2, "current-participant");
        assert.deepEqual(await state(), [
          { version: 1, status: "SUSPENDIDO", open: false },
          { version: 2, status: "SUSPENDIDO", open: false },
        ]);
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
        await assert.rejects(listAgreementVersions(domain, actor(0), tenant), {
          code: "FORBIDDEN",
        });
      },
    );
  });
});
