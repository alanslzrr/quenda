import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { transaction } from "../../src/database/transaction.ts";
import { processInvitationEmail } from "../../src/modules/communications/index.ts";
import {
  inviteAdministrator,
  revokeAdministratorInvitation,
} from "../../src/modules/identity/invitations.ts";
import {
  acceptManager,
  inviteManager,
  revokeManager,
} from "../../src/modules/identity/manager.ts";
import { revokeAddressInvitationsForSecurity } from "../../src/modules/identity/municipal-continuity.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
  replaceInitialAdministratorInvitation,
} from "../../src/modules/identity/municipality.ts";
import { inviteOperator } from "../../src/modules/identity/operator-lifecycle.ts";
import { inviteGlobalPrivacy } from "../../src/modules/identity/privacy-permissions.ts";
import { suspendAccount } from "../../src/modules/identity/security.ts";
import type { MailMessage, MailTransport } from "../../src/shared/mail.ts";
import { withDatabase } from "../helpers/postgres.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const deadline = new Date(Date.now() + 86_400_000).toISOString();
const options = {
  origin: "https://quenda.example.test",
  locale: "es" as const,
  leaseSeconds: 30,
  maxAttempts: 2,
  retrySeconds: 1,
};
const permissions = [{ operation: "RESERVATION_READ" as const, unitId: null }];
type Queued = {
  id: string;
  kind: string;
  tenant_id: string | null;
  invitation_id: string;
  recipient_email: string | null;
  attempts: number;
  exhausted_at: Date | null;
};
const queued = async (pool: Pool, invitation?: string) =>
  (
    await pool.query<Queued>(
      "SELECT * FROM domain.invitation_email WHERE $1::uuid IS NULL OR invitation_id=$1 ORDER BY created_at,id",
      [invitation ?? null],
    )
  ).rows;
function capture() {
  const sent: MailMessage[] = [];
  return {
    sent,
    transport: {
      send: async (message: MailMessage) => {
        sent.push(message);
      },
    },
  };
}
async function drain(worker: Pool, transport: MailTransport) {
  const outcomes: string[] = [];
  for (let n = 0; n < 50; n++) {
    const outcome = await processInvitationEmail(worker, transport, options);
    if (outcome === "IDLE") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

test("invitation notices are queued per address, never reveal accounts and stop when the invitation ends", {
  timeout: 180_000,
}, async (t) => {
  await withDatabase(async ({ root, domain, auth, migration, worker }) => {
    for (const [id, email] of [
      ["operator", "operator@example.test"],
      ["admin", "admin@example.test"],
      ["existing", "existing@example.test"],
      ["staff", "staff@example.test"],
      ["owner", "owner@example.test"],
    ])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,true,now(),now(),true)',
        [id, email],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const municipality = await createMunicipality(domain, actor("operator"), {
      name: "Concello de Proba",
      timezone: "Europe/Madrid",
      administratorEmail: "admin@example.test",
      invitationExpiresAt: deadline,
    });
    const tenant = municipality.tenantId;
    // The initial invitation was queued and leaves the queue on acceptance.
    assert.deepEqual(
      (await queued(migration, municipality.invitationId)).map((row) => [
        row.kind,
        row.tenant_id,
        row.recipient_email,
      ]),
      [["ADMINISTRATOR", tenant, "admin@example.test"]],
    );
    await acceptAdministratorInvitation(
      domain,
      actor("admin"),
      tenant,
      municipality.invitationId,
    );
    assert.equal((await queued(migration)).length, 0);

    await t.test(
      "creation queues the same notice for a registered and an unknown address",
      async () => {
        const registered = await inviteManager(domain, actor("admin"), tenant, {
          email: "Existing@Example.test",
          expiresAt: deadline,
          permissions,
        });
        const unknown = await inviteManager(domain, actor("admin"), tenant, {
          email: "nobody@example.test",
          expiresAt: deadline,
          permissions,
        });
        const rows = await queued(migration);
        assert.deepEqual(
          rows.map((row) => [
            row.kind,
            row.tenant_id,
            row.invitation_id,
            row.recipient_email,
            row.attempts,
            row.exhausted_at,
          ]),
          [
            [
              "MANAGER",
              tenant,
              registered.invitationId,
              "existing@example.test",
              0,
              null,
            ],
            [
              "MANAGER",
              tenant,
              unknown.invitationId,
              "nobody@example.test",
              0,
              null,
            ],
          ],
        );
        const operator = await inviteOperator(domain, actor("operator"), {
          email: "future-operator@example.test",
          expiresAt: deadline,
        });
        const privacy = await inviteGlobalPrivacy(domain, actor("operator"), {
          email: "privacy@example.test",
          permissions: ["PRIVACY_READ"],
          expiresAt: deadline,
          reason: "Delegación aprobada",
        });
        assert.deepEqual(
          [
            ...(await queued(migration, operator.invitationId)),
            ...(await queued(migration, privacy.invitationId)),
          ].map((row) => [row.kind, row.tenant_id]),
          [
            ["OPERATOR", null],
            ["PRIVACY", null],
          ],
        );
        // The web role neither reads the queue nor claims from it.
        for (const sql of [
          "SELECT * FROM domain.invitation_email",
          "SELECT * FROM domain.invitation_email_quota",
          "SELECT * FROM domain.claim_invitation_email(60,5)",
          "SELECT * FROM domain.invitation_email_health()",
        ])
          await assert.rejects(domain.query(sql), { code: "42501" }, sql);
        for (const table of [
          "domain.invitation_email",
          "domain.administrator_invitation",
        ])
          await assert.rejects(worker.query(`SELECT * FROM ${table}`), {
            code: "42501",
          });
      },
    );

    await t.test(
      "the worker sends identical content for registered and unknown addresses and keeps nothing",
      async () => {
        const { sent, transport } = capture();
        const outcomes = await drain(worker, transport);
        assert.deepEqual(outcomes, [
          "ACCEPTED",
          "ACCEPTED",
          "ACCEPTED",
          "ACCEPTED",
        ]);
        assert.equal((await queued(migration)).length, 0);
        const byAddress = new Map(sent.map((m) => [m.to, m]));
        const registered = byAddress.get("existing@example.test");
        const unknown = byAddress.get("nobody@example.test");
        assert.ok(registered && unknown);
        assert.equal(registered.subject, unknown.subject);
        assert.equal(registered.text, unknown.text);
        assert.match(
          registered.text,
          /gestionar el municipio Concello de Proba/,
        );
        assert.match(
          registered.text,
          /https:\/\/quenda\.example\.test\/perfil\/invitaciones$/m,
        );
        assert.match(registered.text, /«Mi cuenta › Invitaciones»/);
        assert.match(registered.text, /verificación en dos pasos/);
        assert.match(registered.text, /Zona horaria: Europe\/Madrid/);
        // No inviter, account, invitation identifier or token is disclosed.
        for (const message of sent) {
          assert.ok(!message.text.includes("admin@example.test"));
          assert.ok(!message.text.includes("operator@"));
          assert.ok(!message.text.includes("existing"));
          assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(message.text));
          assert.ok(!/[?&](token|code)=/.test(message.text));
        }
        assert.match(
          byAddress.get("future-operator@example.test")?.text ?? "",
          /operar la plataforma Quenda/,
        );
        assert.match(
          byAddress.get("privacy@example.test")?.text ?? "",
          /Zona horaria: UTC/,
        );
        assert.deepEqual(
          (await worker.query("SELECT * FROM domain.invitation_email_health()"))
            .rows[0],
          { pending: "0", leased: "0", exhausted: "0" },
        );
      },
    );

    await t.test(
      "revocation, replacement, acceptance and security withdrawal cancel a pending notice",
      async () => {
        const administrator = await inviteAdministrator(
          domain,
          actor("admin"),
          tenant,
          { email: "revoked@example.test", expiresAt: deadline },
        );
        assert.equal(
          (await queued(migration, administrator.invitationId)).length,
          1,
        );
        await revokeAdministratorInvitation(
          domain,
          actor("admin"),
          tenant,
          administrator.invitationId,
        );
        const manager = await inviteManager(domain, actor("admin"), tenant, {
          email: "withdrawn@example.test",
          expiresAt: deadline,
          permissions,
        });
        await revokeManager(
          domain,
          actor("admin"),
          tenant,
          manager.invitationId,
          "Ya no procede",
        );
        const address = await inviteManager(domain, actor("admin"), tenant, {
          email: "suspicious@example.test",
          expiresAt: deadline,
          permissions,
        });
        await revokeAddressInvitationsForSecurity(
          domain,
          actor("admin"),
          tenant,
          "suspicious@example.test",
          "Dirección comprometida",
        );
        const accepted = await inviteManager(domain, actor("admin"), tenant, {
          email: "staff@example.test",
          expiresAt: deadline,
          permissions,
        });
        await acceptManager(
          domain,
          actor("staff"),
          tenant,
          accepted.invitationId,
        );
        // A scope replacement is addressed to the holder: nothing is mailed.
        await inviteManager(domain, actor("admin"), tenant, {
          replacesInvitationId: accepted.invitationId,
          reason: "Nuevo alcance",
          expiresAt: deadline,
          permissions: [{ operation: "REPORT_READ", unitId: null }],
        });
        const suspended = await inviteManager(domain, actor("admin"), tenant, {
          email: "owner@example.test",
          expiresAt: deadline,
          permissions,
        });
        await suspendAccount(
          domain,
          actor("operator"),
          "owner",
          "Compromiso verificado",
          randomUUID(),
        );
        const fresh = await createMunicipality(domain, actor("operator"), {
          name: "Concello de Relevo",
          timezone: "Europe/Madrid",
          administratorEmail: "first@example.test",
          invitationExpiresAt: deadline,
        });
        await replaceInitialAdministratorInvitation(
          domain,
          actor("operator"),
          fresh.tenantId,
          {
            email: "second@example.test",
            expiresAt: deadline,
            reason: "Cambio de responsable",
          },
        );
        for (const id of [
          administrator.invitationId,
          manager.invitationId,
          address.invitationId,
          accepted.invitationId,
          suspended.invitationId,
          fresh.invitationId,
        ])
          assert.equal((await queued(migration, id)).length, 0, id);
        assert.deepEqual(
          (await queued(migration)).map((row) => row.recipient_email),
          ["second@example.test"],
        );
        const { sent, transport } = capture();
        assert.deepEqual(await drain(worker, transport), ["ACCEPTED"]);
        assert.deepEqual(
          sent.map((m) => m.to),
          ["second@example.test"],
        );
        assert.match(sent[0]?.text ?? "", /Concello de Relevo/);
      },
    );

    await t.test(
      "an expired invitation is never sent and retention withdraws a queued address",
      async () => {
        const expired = await inviteManager(domain, actor("admin"), tenant, {
          email: "late@example.test",
          expiresAt: deadline,
          permissions,
        });
        await migration.query(
          "UPDATE domain.manager_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND id=$2",
          [tenant, expired.invitationId],
        );
        const { sent, transport } = capture();
        assert.deepEqual(await drain(worker, transport), []);
        assert.equal(sent.length, 0);
        assert.equal((await queued(migration, expired.invitationId)).length, 0);
        // With the worker stopped, AUTHORITY retention of an ended address
        // also removes the queued notice.
        const stopped = await inviteManager(domain, actor("admin"), tenant, {
          email: "stopped@example.test",
          expiresAt: deadline,
          permissions,
        });
        await migration.query(
          "UPDATE domain.manager_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE tenant_id=$1 AND id=$2",
          [tenant, stopped.invitationId],
        );
        assert.equal((await queued(migration, stopped.invitationId)).length, 1);
        const result = await transaction(
          migration,
          async (client) =>
            (
              await client.query(
                "SELECT domain.retention_municipal_action($1,'AUTHORITY',$2,$3) AS result",
                [
                  tenant,
                  `address:manager:${stopped.invitationId}`,
                  new Date(Date.now() + 2000).toISOString(),
                ],
              )
            ).rows[0].result,
        );
        assert.equal(result.status, "APPLIED");
        assert.equal((await queued(migration, stopped.invitationId)).length, 0);
      },
    );

    await t.test(
      "failed attempts retry, exhaustion clears the address and the row ends with its invitation",
      async () => {
        const failing = {
          send: async () => {
            throw new Error("Provider unavailable for synthetic@address");
          },
        };
        const invitation = await inviteManager(domain, actor("admin"), tenant, {
          email: "bounce@example.test",
          expiresAt: deadline,
          permissions,
        });
        assert.equal(
          await processInvitationEmail(worker, failing, options),
          "RETRY_SCHEDULED",
        );
        await migration.query(
          "UPDATE domain.invitation_email SET next_attempt_at=now()-interval '1 second' WHERE invitation_id=$1",
          [invitation.invitationId],
        );
        assert.equal(
          await processInvitationEmail(worker, failing, options),
          "EXHAUSTED",
        );
        const [row] = await queued(migration, invitation.invitationId);
        assert.equal(row?.recipient_email, null);
        assert.ok(row?.exhausted_at);
        assert.deepEqual(
          (await worker.query("SELECT * FROM domain.invitation_email_health()"))
            .rows[0],
          { pending: "0", leased: "0", exhausted: "1" },
        );
        // An exhausted notice is not retried and no address remains to send.
        assert.equal(
          await processInvitationEmail(worker, capture().transport, options),
          "IDLE",
        );
        await revokeManager(
          domain,
          actor("admin"),
          tenant,
          invitation.invitationId,
          "Dirección rechazada",
        );
        assert.equal(
          (await queued(migration, invitation.invitationId)).length,
          0,
        );
      },
    );

    await t.test(
      "a municipality queues at most 100 notices in 24 hours, independently of accounts",
      async () => {
        await migration.query(
          "UPDATE domain.invitation_email_quota SET window_started_at=now(),queued=100 WHERE scope=$1",
          [tenant],
        );
        const limited = await inviteManager(domain, actor("admin"), tenant, {
          email: "existing@example.test",
          expiresAt: deadline,
          permissions,
        });
        // The invitation exists and can be accepted in the application.
        assert.equal((await queued(migration, limited.invitationId)).length, 0);
        assert.equal(
          (
            await migration.query(
              "SELECT 1 FROM domain.manager_invitation WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL",
              [tenant, limited.invitationId],
            )
          ).rowCount,
          1,
        );
        await migration.query(
          "UPDATE domain.invitation_email_quota SET window_started_at=now()-interval '25 hours' WHERE scope=$1",
          [tenant],
        );
        const renewed = await inviteManager(domain, actor("admin"), tenant, {
          email: "renewed@example.test",
          expiresAt: deadline,
          permissions,
        });
        assert.equal((await queued(migration, renewed.invitationId)).length, 1);
        await revokeManager(
          domain,
          actor("admin"),
          tenant,
          renewed.invitationId,
          "Fin de la prueba",
        );
      },
    );

    await t.test(
      "the worker process delivers through the local transport and reports invitation health",
      async () => {
        await inviteManager(domain, actor("admin"), tenant, {
          email: "process@example.test",
          expiresAt: deadline,
          permissions,
        });
        const mailDir = path.join(root, "invitation-mail");
        const execution = await promisify(execFile)(
          process.execPath,
          ["dist/email-worker.js", "--once"],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              WORKER_DATABASE_URL: worker.options.connectionString,
              AUTH_ORIGIN: "https://quenda.test",
              LOCAL_MAIL_DIR: mailDir,
              EMAIL_LOCALE: "gl",
            },
            timeout: 15000,
          },
        );
        assert.match(
          execution.stdout,
          /"event":"INVITATION_EMAIL_ATTEMPT","outcome":"ACCEPTED"/,
        );
        assert.match(execution.stdout, /INVITATION_EMAIL_QUEUE_HEALTH/);
        assert.ok(!execution.stdout.includes("@example.test"));
        assert.ok(!execution.stderr.includes("@example.test"));
        const files = await readdir(mailDir);
        assert.equal(files.length, 1);
        const message = JSON.parse(
          await readFile(path.join(mailDir, files[0] as string), "utf8"),
        );
        assert.equal(message.to, "process@example.test");
        assert.equal(message.subject, "Quenda — Invitación pendente");
        assert.match(message.text, /xestionar o municipio Concello de Proba/);
        assert.match(
          message.text,
          /https:\/\/quenda\.test\/perfil\/invitaciones/,
        );
      },
    );
  });
});
