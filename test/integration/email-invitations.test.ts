import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { buildApp } from "../../src/app.ts";
import { createAuthentication } from "../../src/modules/identity/auth.ts";
import {
  inviteAdministrator,
  listOwnAdministratorInvitations,
} from "../../src/modules/identity/invitations.ts";
import {
  acceptManager,
  inviteManager,
  listOwnManagerInvitations,
} from "../../src/modules/identity/manager.ts";
import { listMunicipalManagerInvitations } from "../../src/modules/identity/manager-query.ts";
import {
  acceptAdministratorInvitation,
  createMunicipality,
} from "../../src/modules/identity/municipality.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser, totp } from "../helpers/auth-client.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { verifyProductResponses } from "../helpers/response-contract.ts";

const actor = (id: string) => ({
  accountId: id,
  email: `${id}@example.test`,
  sessionId: `session-${id}`,
  mfaVerifiedAt: new Date(),
});
const expiry = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const permissions = [{ operation: "CATALOG_CREATE" as const, unitId: null }];

test("invitations addressed by email reveal nothing at creation and follow the verified address", {
  timeout: 120_000,
}, async (t) => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const users: Array<[string, string, boolean]> = [
      ["operator", "operator@example.test", true],
      ["admin", "admin@example.test", true],
      ["invitee", "invitee@example.test", true],
      ["other", "other@example.test", true],
      ["unverified", "unverified@example.test", false],
      ["mover", "mover-old@example.test", true],
      ["previous", "moving-address@example.test", true],
      ["legacy", "legacy@example.test", true],
    ];
    for (const [id, email, verified] of users)
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled") VALUES($1,$1,$2,$3,now(),now(),true)',
        [id, email, verified],
      );
    const owner = await migration.connect();
    try {
      await initializeOperator(owner, "operator");
    } finally {
      owner.release();
    }
    const municipality = await createMunicipality(domain, actor("operator"), {
      name: "Email invitations",
      timezone: "Europe/Madrid",
      administratorEmail: "  ADMIN@Example.TEST ",
      invitationExpiresAt: expiry(),
    });
    const tenant = municipality.tenantId;
    const stored = await migration.query(
      "SELECT account_id,recipient_email FROM domain.administrator_invitation WHERE id=$1",
      [municipality.invitationId],
    );
    assert.deepEqual(stored.rows[0], {
      account_id: null,
      recipient_email: "admin@example.test",
    });
    await acceptAdministratorInvitation(
      domain,
      actor("admin"),
      tenant,
      municipality.invitationId,
    );
    const accepted = await migration.query(
      "SELECT account_id,recipient_email,accepted_at IS NOT NULL AS accepted FROM domain.administrator_invitation WHERE id=$1",
      [municipality.invitationId],
    );
    // Acceptance binds the account and drops the address.
    assert.deepEqual(accepted.rows[0], {
      account_id: "admin",
      recipient_email: null,
      accepted: true,
    });

    await t.test(
      "only the account with the matching verified email sees and accepts",
      async () => {
        const invitation = await inviteAdministrator(
          domain,
          actor("admin"),
          tenant,
          { email: "Invitee@Example.test", expiresAt: expiry() },
        );
        for (const id of ["other", "unverified", "operator"]) {
          const own = await listOwnAdministratorInvitations(domain, actor(id));
          assert.ok(
            !own.items.some((i) => i.invitationId === invitation.invitationId),
            id,
          );
          await assert.rejects(
            acceptAdministratorInvitation(
              domain,
              actor(id),
              tenant,
              invitation.invitationId,
            ),
            { code: "NOT_FOUND" },
            id,
          );
        }
        const own = await listOwnAdministratorInvitations(
          domain,
          actor("invitee"),
        );
        assert.equal(
          own.items.find((i) => i.invitationId === invitation.invitationId)
            ?.status,
          "PENDING",
        );
        // Acceptance still requires a recent second factor.
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            { ...actor("invitee"), mfaVerifiedAt: null },
            tenant,
            invitation.invitationId,
          ),
        );
        await acceptAdministratorInvitation(
          domain,
          actor("invitee"),
          tenant,
          invitation.invitationId,
        );
        // One-time use: the bound invitation cannot be accepted again.
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            actor("invitee"),
            tenant,
            invitation.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
      },
    );

    await t.test(
      "an unverified account with the address cannot see or accept",
      async () => {
        const invitation = await inviteManager(domain, actor("admin"), tenant, {
          email: "unverified@example.test",
          expiresAt: expiry(),
          permissions,
        });
        const own = await listOwnManagerInvitations(
          domain,
          actor("unverified"),
        );
        assert.equal(own.items.length, 0);
        await assert.rejects(
          acceptManager(
            domain,
            actor("unverified"),
            tenant,
            invitation.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        // Verifying the address later makes the same invitation acceptable.
        await migration.query(
          'UPDATE auth."user" SET "emailVerified"=true WHERE id=$1',
          ["unverified"],
        );
        await acceptManager(
          domain,
          actor("unverified"),
          tenant,
          invitation.invitationId,
        );
      },
    );

    await t.test(
      "the invitation follows the address when emails change",
      async () => {
        const invitation = await inviteManager(domain, actor("admin"), tenant, {
          email: "moving-address@example.test",
          expiresAt: expiry(),
          permissions,
        });
        assert.equal(
          (await listOwnManagerInvitations(domain, actor("previous"))).items
            .length,
          1,
        );
        assert.equal(
          (await listOwnManagerInvitations(domain, actor("mover"))).items
            .length,
          0,
        );
        // The holder of the address moves away and the invitee takes it over.
        await migration.query('UPDATE auth."user" SET email=$2 WHERE id=$1', [
          "previous",
          "previous-new@example.test",
        ]);
        await migration.query(
          'UPDATE auth."user" SET email=$2,"emailVerified"=true WHERE id=$1',
          ["mover", "moving-address@example.test"],
        );
        assert.equal(
          (await listOwnManagerInvitations(domain, actor("previous"))).items
            .length,
          0,
        );
        await assert.rejects(
          acceptManager(
            domain,
            actor("previous"),
            tenant,
            invitation.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
        const own = await listOwnManagerInvitations(domain, actor("mover"));
        assert.equal(own.items[0]?.invitationId, invitation.invitationId);
        await acceptManager(
          domain,
          actor("mover"),
          tenant,
          invitation.invitationId,
        );
        // Once accepted the invitation belongs to the account, not the address.
        await migration.query('UPDATE auth."user" SET email=$2 WHERE id=$1', [
          "mover",
          "mover-final@example.test",
        ]);
        assert.equal(
          (await listOwnManagerInvitations(domain, actor("mover"))).items[0]
            ?.status,
          "ACTIVE",
        );
        const history = await listMunicipalManagerInvitations(
          domain,
          actor("admin"),
          tenant,
        );
        const row = history.items.find(
          (i) => i.invitationId === invitation.invitationId,
        );
        assert.equal(row?.accountId, "mover");
        assert.equal(row?.recipientEmail, null);
        assert.equal(row?.accountLabel?.email, "mover-final@example.test");
      },
    );

    await t.test(
      "revoked and expired email invitations cannot be accepted",
      async () => {
        const revoked = await inviteManager(domain, actor("admin"), tenant, {
          email: "other@example.test",
          expiresAt: expiry(),
          permissions,
        });
        await migration.query(
          "UPDATE domain.manager_invitation SET revoked_at=now() WHERE id=$1",
          [revoked.invitationId],
        );
        await assert.rejects(
          acceptManager(domain, actor("other"), tenant, revoked.invitationId),
          { code: "NOT_FOUND" },
        );
        const expired = await inviteAdministrator(
          domain,
          actor("admin"),
          tenant,
          { email: "other@example.test", expiresAt: expiry() },
        );
        await migration.query(
          "UPDATE domain.administrator_invitation SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 second' WHERE id=$1",
          [expired.invitationId],
        );
        await assert.rejects(
          acceptAdministratorInvitation(
            domain,
            actor("other"),
            tenant,
            expired.invitationId,
          ),
          { code: "NOT_FOUND" },
        );
      },
    );

    await t.test(
      "account-addressed invitations from before the migration stay valid",
      async () => {
        const issuer = await migration.query<{ invitation_id: string }>(
          "SELECT invitation_id FROM domain.municipal_administrator WHERE tenant_id=$1 AND account_id='admin'",
          [tenant],
        );
        const administratorInvitation = randomUUID();
        const managerInvitation = randomUUID();
        await migration.query(
          "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,grant_source,issuer_invitation_id) VALUES($1,$2,'legacy','admin',now()+interval '1 hour','MUNICIPAL',$3)",
          [tenant, administratorInvitation, issuer.rows[0]?.invitation_id],
        );
        await migration.query(
          "INSERT INTO domain.manager_invitation(tenant_id,id,account_id,invited_by,issuer_invitation_id,expires_at) VALUES($1,$2,'legacy','admin',$3,now()+interval '1 hour')",
          [tenant, managerInvitation, issuer.rows[0]?.invitation_id],
        );
        await migration.query(
          "INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id) VALUES($1,$2,'CATALOG_CREATE',NULL)",
          [tenant, managerInvitation],
        );
        // The legacy account changed its email: it is still the recipient.
        await migration.query('UPDATE auth."user" SET email=$2 WHERE id=$1', [
          "legacy",
          "legacy-new@example.test",
        ]);
        await assert.rejects(
          acceptManager(domain, actor("other"), tenant, managerInvitation),
          { code: "NOT_FOUND" },
        );
        const own = await listOwnAdministratorInvitations(
          domain,
          actor("legacy"),
        );
        assert.equal(own.items[0]?.status, "PENDING");
        await acceptAdministratorInvitation(
          domain,
          actor("legacy"),
          tenant,
          administratorInvitation,
        );
        await acceptManager(domain, actor("legacy"), tenant, managerInvitation);
      },
    );

    await t.test(
      "an invalid address is rejected before anything is written",
      async () => {
        for (const email of [
          "",
          "   ",
          "no-at-sign",
          "two@@example.test",
          "a b@example.test",
        ])
          await assert.rejects(
            inviteAdministrator(domain, actor("admin"), tenant, {
              email,
              expiresAt: expiry(),
            }),
            { code: "INVALID_INPUT" },
            email,
          );
        // A new invitation has exactly one recipient: an address or a replaced grant.
        await assert.rejects(
          inviteManager(domain, actor("admin"), tenant, {
            expiresAt: expiry(),
            permissions,
          }),
          { code: "INVALID_INPUT" },
        );
      },
    );
  });
});

test("creating an email invitation answers the same whether or not the address is registered", {
  timeout: 120_000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    const messages: MailMessage[] = [];
    const config = {
      origin: "https://quenda.test",
      secret: randomBytes(32).toString("hex"),
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain,
      logLevel: "silent",
      identity: {
        config,
        authentication: createAuthentication(auth, config, {
          send: async (message) => {
            messages.push(message);
          },
        }),
      },
    });
    const contracts = verifyProductResponses(app);
    const password = "Synthetic-invitation-journey-123!";
    try {
      const register = async (name: string, ip: string) => {
        const client = browser(app, ip),
          email = `${name}@example.test`;
        const signUp = await client.request("/api/auth/sign-up/email", {
          name,
          email,
          password,
        });
        assert.equal(signUp.statusCode, 200, signUp.body);
        const message = messages.find(
          (value) => value.to === email && value.text.includes("verify-email"),
        );
        assert.ok(message);
        const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
        await client.request(link.pathname + link.search);
        const signIn = await client.request("/api/auth/sign-in/email", {
          email,
          password,
        });
        assert.equal(signIn.statusCode, 200, signIn.body);
        const enrollment = (
          await client.request("/api/auth/two-factor/enable", { password })
        ).json();
        const secret = new URL(enrollment.totpURI).searchParams.get("secret");
        assert.ok(secret);
        const verified = await client.request(
          "/api/auth/two-factor/verify-totp",
          { code: totp(secret) },
        );
        assert.equal(verified.statusCode, 200, verified.body);
        return { client, id: signUp.json().user.id as string };
      };
      const operator = await register("platform-operator", "192.0.2.181");
      const owner = await migration.connect();
      try {
        await initializeOperator(owner, operator.id);
      } finally {
        owner.release();
      }
      const administrator = await register("first-admin", "192.0.2.182");
      const invitee = await register("registered-invitee", "192.0.2.183");
      const outsider = await register("outsider", "192.0.2.184");

      const created = await operator.client.request("/api/municipalities", {
        name: "Email onboarding",
        timezone: "Europe/Madrid",
        administratorEmail: " First-Admin@example.test",
        invitationExpiresAt: expiry(),
      });
      assert.equal(created.statusCode, 201, created.body);
      const { tenantId, invitationId } = created.json();
      const pending = (
        await administrator.client.request("/api/me/administrator-invitations")
      ).json();
      assert.equal(pending.items[0]?.invitationId, invitationId);
      const accept = await administrator.client.request(
        `/api/municipalities/${tenantId}/administrator-invitations/${invitationId}/accept`,
        {},
      );
      assert.equal(accept.statusCode, 200, accept.body);

      // The request body no longer accepts an account identifier.
      const legacyBody = await administrator.client.request(
        `/api/municipalities/${tenantId}/administrator-invitations`,
        { accountId: invitee.id, expiresAt: expiry() },
      );
      assert.equal(legacyBody.statusCode, 400);
      const malformed = await administrator.client.request(
        `/api/municipalities/${tenantId}/administrator-invitations`,
        { email: "not-an-address", expiresAt: expiry() },
      );
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, "INVALID_INPUT");

      const shape = (body: Record<string, unknown>) =>
        Object.entries(body)
          .map(([key, value]) => [key, typeof value])
          .sort();
      for (const kind of ["administrator", "manager"] as const) {
        const send = (email: string) =>
          administrator.client.request(
            `/api/municipalities/${tenantId}/${kind}-invitations`,
            {
              email,
              expiresAt: expiry(),
              ...(kind === "manager" ? { permissions } : {}),
            },
          );
        const registered = await send("registered-invitee@example.test");
        const unknown = await send("nobody-registered@example.test");
        assert.equal(registered.statusCode, 201, registered.body);
        assert.equal(unknown.statusCode, registered.statusCode);
        assert.equal(unknown.statusCode, 201, unknown.body);
        assert.deepEqual(shape(registered.json()), shape(unknown.json()));
        assert.deepEqual(
          Object.keys(registered.headers).sort(),
          Object.keys(unknown.headers).sort(),
        );
        // No account name or identifier is echoed back.
        for (const response of [registered, unknown]) {
          assert.ok(!response.body.includes("registered-invitee"));
          assert.ok(!response.body.includes(invitee.id));
        }
      }

      const own = (
        await invitee.client.request("/api/me/manager-invitations")
      ).json();
      assert.equal(own.items.length, 1);
      const managerInvitation = own.items[0].invitationId as string;
      assert.equal(
        (await outsider.client.request("/api/me/manager-invitations")).json()
          .items.length,
        0,
      );
      const outsiderAccept = await outsider.client.request(
        `/api/municipalities/${tenantId}/manager-invitations/${managerInvitation}/accept`,
        {},
      );
      assert.equal(outsiderAccept.statusCode, 404);
      const accepted = await invitee.client.request(
        `/api/municipalities/${tenantId}/manager-invitations/${managerInvitation}/accept`,
        {},
      );
      assert.equal(accepted.statusCode, 200, accepted.body);

      // The inviter's history shows the address while pending and the
      // accepting account once accepted; an unknown address shows no account.
      const history = (
        await administrator.client.request(
          `/api/municipalities/${tenantId}/manager-invitations`,
        )
      ).json() as {
        items: Array<{
          invitationId: string;
          accountId: string | null;
          recipientEmail: string | null;
          accountLabel: { email: string } | null;
        }>;
      };
      const acceptedRow = history.items.find(
        (i) => i.invitationId === managerInvitation,
      );
      assert.equal(acceptedRow?.accountId, invitee.id);
      assert.equal(acceptedRow?.recipientEmail, null);
      assert.equal(
        acceptedRow?.accountLabel?.email,
        "registered-invitee@example.test",
      );
      const unknownRow = history.items.find(
        (i) => i.recipientEmail === "nobody-registered@example.test",
      );
      assert.equal(unknownRow?.accountId, null);
      assert.equal(unknownRow?.accountLabel, null);
      const administrators = (
        await administrator.client.request(
          `/api/municipalities/${tenantId}/administrator-invitations`,
        )
      ).json() as { items: Array<{ recipientEmail: string | null }> };
      assert.deepEqual(
        administrators.items
          .map((i) => i.recipientEmail)
          .filter((value) => value !== null)
          .sort(),
        ["nobody-registered@example.test", "registered-invitee@example.test"],
      );
      contracts.assertValid();
    } finally {
      await app.close();
    }
  });
});
