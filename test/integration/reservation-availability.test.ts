import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { transaction } from "../../src/database/transaction.ts";
import { publicAvailability } from "../../src/modules/catalog/index.ts";
import { ownModificationAvailability } from "../../src/modules/reservations/availability.ts";
import {
  cancelReservation,
  createBlock,
  createReservation,
} from "../../src/modules/reservations/index.ts";
import { withDatabase } from "../helpers/postgres.ts";
import { initialAcceptance } from "../helpers/usage-rules-fixture.ts";
import { webCatalog as f, seedWebCatalog } from "../helpers/web-catalog.ts";

test("rescheduling availability excludes only the holder's reservation without releasing occupancy", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ auth, domain, migration }) => {
    await seedWebCatalog(auth, migration);
    await auth.query(
      `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES('other','Other','other@example.test',true,now())`,
    );
    const actor = {
      accountId: "web-fixture",
      email: "fixture@example.test",
      sessionId: "synthetic",
      mfaVerifiedAt: new Date(),
    };
    const other = { ...actor, accountId: "other" };
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const interval = (hour: number) => ({
      unitId: f.unit,
      startsAt: `${date}T${hour}:00:00Z`,
      endsAt: `${date}T${hour + 1}:00:00Z`,
      acceptance: initialAcceptance,
    });
    const own = (
      await createReservation(
        domain,
        actor,
        f.tenant,
        randomUUID(),
        interval(10),
        randomUUID(),
        3600,
      )
    ).result;
    await createReservation(
      domain,
      other,
      f.tenant,
      randomUUID(),
      interval(12),
      randomUUID(),
      3600,
    );
    const invitation = randomUUID();
    await migration.query(
      "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
      [f.tenant, invitation, actor.accountId],
    );
    await migration.query(
      "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
      [f.tenant, actor.accountId, invitation],
    );
    await auth.query(
      'UPDATE auth."user" SET "twoFactorEnabled"=true WHERE id=$1',
      [actor.accountId],
    );
    await createBlock(
      domain,
      actor,
      f.tenant,
      randomUUID(),
      {
        unitId: f.unit,
        startsAt: `${date}T14:00:00Z`,
        endsAt: `${date}T15:00:00Z`,
        reason: "Synthetic maintenance",
      },
      randomUUID(),
      3600,
    );
    const includes = (
      result: Awaited<ReturnType<typeof publicAvailability>>,
      time: string,
    ) =>
      result.slots.some(
        (slot) => Date.parse(slot.start.utc) === Date.parse(time),
      );
    const publicBefore = await publicAvailability(
      domain,
      f.tenant,
      f.unit,
      date,
      60,
    );
    assert.equal(includes(publicBefore, `${date}T10:30:00Z`), false);
    const ownSlots = await ownModificationAvailability(
      domain,
      actor,
      f.tenant,
      own.id,
      f.unit,
      date,
      60,
    );
    assert.equal(includes(ownSlots, `${date}T10:30:00Z`), true);
    assert.equal(includes(ownSlots, `${date}T12:00:00Z`), false);
    assert.equal(includes(ownSlots, `${date}T14:00:00Z`), false);
    assert.equal(
      includes(
        await publicAvailability(domain, f.tenant, f.unit, date, 60),
        `${date}T10:30:00Z`,
      ),
      false,
    );
    await assert.rejects(
      ownModificationAvailability(
        domain,
        other,
        f.tenant,
        own.id,
        f.unit,
        date,
        60,
      ),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      ownModificationAvailability(
        domain,
        actor,
        randomUUID(),
        own.id,
        f.unit,
        date,
        60,
      ),
      { code: "NOT_FOUND" },
    );
    const unauthorized = await transaction(
      domain,
      (client) =>
        client.query(
          "SELECT * FROM domain.own_reservation_available_slots($1,$2,$3,ARRAY[$4::timestamptz],ARRAY[$5::timestamptz])",
          [f.tenant, f.unit, own.id, `${date}T10:00:00Z`, `${date}T11:00:00Z`],
        ),
      { tenantId: f.tenant, accountId: other.accountId },
    );
    assert.equal(unauthorized.rowCount, 0);
    await cancelReservation(
      domain,
      actor,
      f.tenant,
      own.id,
      randomUUID(),
      { expectedRevision: own.revision },
      randomUUID(),
      3600,
    );
    await assert.rejects(
      ownModificationAvailability(
        domain,
        actor,
        f.tenant,
        own.id,
        f.unit,
        date,
        60,
      ),
      { code: "RESERVATION_CANCELLED" },
    );
  });
});
