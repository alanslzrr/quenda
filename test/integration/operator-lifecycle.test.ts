import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { recoverOperator } from "../../scripts/lib/recover-operator.ts";
import { buildApp } from "../../src/app.ts";
import { transaction } from "../../src/database/transaction.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import {
  acceptOperatorInvitation,
  inviteOperator,
  listOperatorInvitations,
  listOperators,
  listOwnOperatorInvitations,
  revokeOperator,
  revokeOperatorInvitation,
} from "../../src/modules/identity/operator-lifecycle.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const actor = (accountId: string) => ({
  accountId,
  email: `${accountId}@example.test`,
  sessionId: `session-${accountId}`,
  mfaVerifiedAt: new Date(),
});
const expiresAt = () => new Date(Date.now() + 86400000).toISOString();

test("operator invitations, handover and controlled recovery preserve global authority", {
  timeout: 60000,
}, async (t) => {
  await withDatabase(async ({ auth, domain, migration }) => {
    for (const id of [
      "first",
      "second",
      "third",
      "unverified",
      "no-mfa",
      "inactive",
      "recovered",
    ]) {
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,$3,$4,now(),now())',
        [id, `${id}@example.test`, id !== "unverified", id !== "no-mfa"],
      );
    }
    await migration.query(
      "UPDATE auth.account_lifecycle SET deactivated_at=now() WHERE account_id='inactive'",
    );
    const client = await migration.connect();
    try {
      await t.test(
        "initialization cannot use an inactive verified MFA account",
        async () => {
          await assert.rejects(
            initializeOperator(client, "inactive"),
            /verified account with MFA/,
          );
          await initializeOperator(client, "first");
        },
      );
      await t.test(
        "runtime cannot grant, enumerate or edit authority tables directly",
        async () => {
          for (const sql of [
            "SELECT * FROM domain.platform_operator_invitation",
            "SELECT * FROM domain.platform_operator_event",
            "INSERT INTO domain.platform_operator(account_id) VALUES('third')",
            "UPDATE domain.platform_operator SET revoked_at=NULL",
          ])
            await assert.rejects(domain.query(sql), { code: "42501" });
          await assert.rejects(
            inviteOperator(domain, actor("third"), {
              accountId: "second",
              expiresAt: expiresAt(),
            }),
            { code: "FORBIDDEN" },
          );
          await assert.rejects(listOperators(domain, actor("third")), {
            code: "FORBIDDEN",
          });
          const sqlResult = await transaction(
            domain,
            async (connection) =>
              connection.query(
                "SELECT domain.invite_operator('second',now()+interval '1 day',$1,$2) AS outcome",
                [randomUUID(), randomUUID()],
              ),
            { accountId: "third", tenantId: null },
          );
          assert.equal(sqlResult.rows[0].outcome, "FORBIDDEN");
        },
      );
      await t.test(
        "invites an active verified account before MFA setup, but acceptance requires MFA",
        async () => {
          for (const accountId of ["unverified", "inactive", "absent", "first"])
            await assert.rejects(
              inviteOperator(domain, actor("first"), {
                accountId,
                expiresAt: expiresAt(),
              }),
              { code: "INVALID_INPUT" },
            );
          const invitation = await inviteOperator(domain, actor("first"), {
            accountId: "no-mfa",
            expiresAt: expiresAt(),
          });
          await assert.rejects(
            inviteOperator(domain, actor("first"), {
              accountId: "no-mfa",
              expiresAt: expiresAt(),
            }),
            { code: "ROLE_ALREADY_ACTIVE" },
          );
          assert.equal(
            (
              await listOwnOperatorInvitations(domain, {
                ...actor("no-mfa"),
                mfaVerifiedAt: null,
              })
            ).items[0]?.invitationId,
            invitation.invitationId,
          );
          assert.equal(
            (await listOwnOperatorInvitations(domain, actor("third"))).items
              .length,
            0,
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              { ...actor("no-mfa"), mfaVerifiedAt: null },
              invitation.invitationId,
            ),
            { code: "FORBIDDEN" },
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("no-mfa"),
              invitation.invitationId,
            ),
            { code: "FORBIDDEN" },
          );
          await revokeOperatorInvitation(
            domain,
            actor("first"),
            invitation.invitationId,
            "Destinatario no completa el alta",
          );
          await revokeOperatorInvitation(
            domain,
            actor("first"),
            invitation.invitationId,
            "Reintento de la retirada",
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.platform_operator_event WHERE operation='REVOKE_OPERATOR_INVITATION'",
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("no-mfa"),
              invitation.invitationId,
            ),
            { code: "FORBIDDEN" },
          );
        },
      );
      await t.test(
        "only the recipient accepts and retries do not duplicate grants or audit",
        async () => {
          const invitation = await inviteOperator(domain, actor("first"), {
            accountId: "second",
            expiresAt: expiresAt(),
          });
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("third"),
              invitation.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              {
                ...actor("second"),
                mfaVerifiedAt: new Date(Date.now() - 300001),
              },
              invitation.invitationId,
            ),
            { code: "REAUTHENTICATION_REQUIRED" },
          );
          await acceptOperatorInvitation(
            domain,
            actor("second"),
            invitation.invitationId,
          );
          await acceptOperatorInvitation(
            domain,
            actor("second"),
            invitation.invitationId,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.platform_operator_event WHERE operation='ACCEPT_OPERATOR' AND subject_id='second'",
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (await listOperators(domain, actor("first"))).items.filter(
              (value) => value.active,
            ).length,
            2,
          );
          assert.equal(
            (await listOperatorInvitations(domain, actor("second"))).items.some(
              (value) =>
                value.invitationId === invitation.invitationId &&
                value.status === "ACCEPTED",
            ),
            true,
          );
        },
      );
      await t.test(
        "operator lists show names, never e-mail, of platform accounts only",
        async () => {
          await auth.query(
            `UPDATE auth."user" SET name='Segunda operadora' WHERE id='second'`,
          );
          await auth.query(`UPDATE auth."user" SET name='  ' WHERE id='first'`);
          try {
            const operators = await listOperators(domain, actor("first"));
            assert.deepEqual(
              operators.items.map((o) => [o.accountId, o.accountName]).sort(),
              [
                ["first", null],
                ["second", "Segunda operadora"],
              ],
            );
            const invitations = await listOperatorInvitations(
              domain,
              actor("first"),
            );
            const accepted = invitations.items.find(
              (i) => i.accountId === "second",
            );
            assert.equal(accepted?.accountName, "Segunda operadora");
            assert.equal(accepted?.invitedByName, null);
            assert.ok(!JSON.stringify([operators, invitations]).includes("@"));
            await transaction(
              domain,
              async (client) => {
                const names = await client.query(
                  "SELECT * FROM domain.platform_account_names($1)",
                  [["first", "second", "third", "unverified"]],
                );
                assert.deepEqual(names.rows, [
                  { account_id: "second", name: "Segunda operadora" },
                ]);
              },
              { accountId: "first", tenantId: null },
            );
            await assert.rejects(
              transaction(
                domain,
                (client) =>
                  client.query(
                    "SELECT * FROM domain.platform_account_names($1)",
                    [["second"]],
                  ),
                { accountId: "third", tenantId: null },
              ),
              { code: "42501" },
            );
            await assert.rejects(
              transaction(
                domain,
                (client) =>
                  client.query(
                    "SELECT * FROM domain.platform_account_names($1)",
                    [Array.from({ length: 101 }, (_, n) => `account-${n}`)],
                  ),
                { accountId: "first", tenantId: null },
              ),
              { code: "22023" },
            );
          } finally {
            await auth.query(
              `UPDATE auth."user" SET name=id WHERE id IN ('first','second')`,
            );
          }
        },
      );
      await t.test(
        "withdrawal invalidates pending delegation, never a role already accepted",
        async () => {
          const pending = await inviteOperator(domain, actor("first"), {
            accountId: "third",
            expiresAt: expiresAt(),
          });
          const municipal = await createMunicipality(domain, actor("first"), {
            name: "Pending initial delegation",
            timezone: "Europe/Madrid",
            administratorEmail: "third@example.test",
            invitationExpiresAt: expiresAt(),
          });
          await revokeOperator(
            domain,
            actor("first"),
            "first",
            "Relevo de responsabilidades",
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("third"),
              pending.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
          assert.equal(
            (await listOperators(domain, actor("second"))).items.find(
              (value) => value.accountId === "second",
            )?.active,
            true,
          );
          await assert.rejects(
            revokeOperator(
              domain,
              actor("second"),
              "second",
              "Intento sin sustituto",
            ),
            { code: "ACCOUNT_HANDOVER_REQUIRED" },
          );
          const replacement = await inviteOperator(domain, actor("second"), {
            accountId: "first",
            expiresAt: expiresAt(),
          });
          await acceptOperatorInvitation(
            domain,
            actor("first"),
            replacement.invitationId,
          );
          await assert.rejects(
            acceptAdministratorInvitation(
              domain,
              actor("third"),
              municipal.tenantId,
              municipal.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.identity_event WHERE tenant_id=$1 AND operation='REVOKE_INVITATION'",
                [municipal.tenantId],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("third"),
              pending.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
        },
      );
      await t.test(
        "concurrent self-withdrawals retain one enabled permanent operator",
        async () => {
          const results = await Promise.allSettled([
            revokeOperator(
              domain,
              actor("first"),
              "first",
              "Salida simultánea A",
            ),
            revokeOperator(
              domain,
              actor("second"),
              "second",
              "Salida simultánea B",
            ),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          assert.equal(
            (
              await migration.query(
                "SELECT 1 FROM domain.platform_operator p WHERE revoked_at IS NULL AND domain.responsible_account_enabled(account_id)",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "exceptional recovery neither bypasses a live operator nor reopens bootstrap",
        async () => {
          const evidence = {
            performedBy: "Operations lead",
            authorityReference: "Approved operational record SYNTHETIC-42",
            reason: "Recovery after compromise of the last operator",
          };
          await assert.rejects(
            recoverOperator(client, "recovered", evidence),
            /ordinary handover API/,
          );
          const active = (
            await migration.query(
              "SELECT account_id FROM domain.platform_operator WHERE revoked_at IS NULL",
            )
          ).rows[0].account_id as string;
          const pending = await inviteOperator(domain, actor(active), {
            accountId: "third",
            expiresAt: expiresAt(),
          });
          await migration.query(
            "UPDATE auth.account_lifecycle SET suspended_at=now() WHERE account_id=$1",
            [active],
          );
          await assert.rejects(
            acceptOperatorInvitation(
              domain,
              actor("third"),
              pending.invitationId,
            ),
            { code: "NOT_FOUND" },
          );
          await assert.rejects(
            recoverOperator(client, "inactive", evidence),
            /active verified account/,
          );
          await assert.rejects(
            recoverOperator(client, "recovered", {
              ...evidence,
              authorityReference: " ",
            }),
            /verified recovery evidence/,
          );
          await recoverOperator(client, "recovered", evidence);
          const recovery = (
            await migration.query(
              "SELECT * FROM domain.platform_operator_event WHERE operation='RECOVER_OPERATOR'",
            )
          ).rows[0];
          assert.equal(recovery.subject_id, "recovered");
          assert.equal(
            recovery.authority_reference,
            evidence.authorityReference,
          );
          assert.equal(recovery.operational_actor, evidence.performedBy);
          assert.equal(
            (
              await migration.query(
                "SELECT * FROM domain.operator_initialization",
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            initializeOperator(client, "recovered"),
            /already completed/,
          );
        },
      );
      await t.test(
        "HTTP enforces origin, strict bodies, recipient and recent MFA with documented responses",
        async () => {
          let current = actor("recovered");
          const app = await buildApp({
            logLevel: "silent",
            database: { check: async () => {}, close: async () => {} },
            domain,
            identity: {
              config: {
                origin: "https://quenda.example.test",
                secret: "synthetic-only",
              },
              authentication: {
                handler: async () => new Response(null, { status: 404 }),
                schema: async () => {
                  throw new Error("Not used by this test");
                },
                verifyDeactivation: async () => {
                  throw new Error("Not used by this test");
                },
                requestReactivation: async () => {
                  throw new Error("Not used by this test");
                },
                confirmReactivation: async () => {
                  throw new Error("Not used by this test");
                },
                requestEmailChange: async () => {
                  throw new Error("Not used");
                },
                approveEmailChange: async () => {
                  throw new Error("Not used");
                },
                confirmEmailChange: async () => {
                  throw new Error("Not used");
                },
                authenticate: async () => current,
              },
            },
          });
          try {
            const responses = verifyProductResponses(app);
            await app.ready();
            const url = "/api/platform/operator-invitations";
            const payload = { accountId: "third", expiresAt: expiresAt() };
            assert.equal(
              (await app.inject({ method: "POST", url, payload })).statusCode,
              403,
            );
            const headers = { origin: "https://quenda.example.test" };
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url,
                  headers,
                  payload: { ...payload, role: "OPERATOR" },
                })
              ).statusCode,
              400,
            );
            const invited = await app.inject({
              method: "POST",
              url,
              headers,
              payload,
            });
            assert.equal(invited.statusCode, 201, invited.body);
            const invitationId = invited.json().invitationId as string;
            current = actor("third");
            const accept = `${url}/${invitationId}/accept`;
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url: accept,
                  headers,
                  payload: { accountId: "recovered" },
                })
              ).statusCode,
              400,
            );
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url: accept,
                  headers,
                  payload: {},
                })
              ).statusCode,
              200,
            );
            const listed = await app.inject({
              method: "GET",
              url: "/api/platform/operators",
            });
            assert.equal(listed.statusCode, 200, listed.body);
            assert.equal(
              listed
                .json()
                .items.find(
                  (value: { accountId: string }) => value.accountId === "third",
                ).active,
              true,
            );
            responses.assertValid();
          } finally {
            await app.close();
          }
        },
      );
    } finally {
      client.release();
    }
  });
});
