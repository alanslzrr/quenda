import assert from "node:assert/strict";
import test from "node:test";
import { command } from "../../src/database/command.ts";
import {
  readAccountPreferences,
  saveAccountPreferences,
} from "../../src/modules/identity/preferences.ts";
import { accountTheme } from "../../src/modules/identity/theme-preferences.ts";
import { withDatabase } from "../helpers/postgres.ts";

test("account theme is isolated, exported and independent of notice locale", {
  timeout: 60000,
}, async () => {
  await withDatabase(async ({ domain, auth, migration }) => {
    const actor = (id: string) => ({
      accountId: id,
      email: `${id}@example.test`,
      sessionId: id,
      mfaVerifiedAt: null,
    });
    for (const id of ["one", "two"])
      await auth.query(
        'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, `${id}@example.test`],
      );
    assert.deepEqual(await accountTheme(domain, actor("one")), { theme: null });
    await saveAccountPreferences(domain, actor("one"), "gl");
    await accountTheme(domain, actor("one"), { theme: "dark" });
    assert.deepEqual(await readAccountPreferences(domain, actor("one")), {
      locale: "gl",
    });
    await saveAccountPreferences(domain, actor("one"), "es");
    assert.deepEqual(await accountTheme(domain, actor("one")), {
      theme: "dark",
    });
    assert.deepEqual(await accountTheme(domain, actor("two")), { theme: null });
    const records = await migration.query(
      "SELECT record FROM domain.personal_data_records('one',NULL,true,false) WHERE record_type='account'",
    );
    assert.equal(records.rows[0].record.theme, "dark");
    assert.equal(records.rows[0].record.locale, "es");
    await assert.rejects(
      command(domain, { accountId: "two", tenantId: null }, (client) =>
        client.query(
          "INSERT INTO domain.account_preferences(account_id,theme) VALUES('one','light') ON CONFLICT(account_id) DO UPDATE SET theme=EXCLUDED.theme",
        ),
      ),
      { code: "42501" },
    );
    await accountTheme(domain, actor("one"), { theme: "system" });
    assert.deepEqual(await accountTheme(domain, actor("one")), {
      theme: "system",
    });
    assert.equal(
      (
        await migration.query(
          "SELECT record FROM domain.personal_data_records('one',NULL,true,false) WHERE record_type='account'",
        )
      ).rows[0].record.theme,
      "system",
    );
    await assert.rejects(
      accountTheme(domain, actor("one"), { theme: "invalid" as never }),
    );
    await accountTheme(domain, actor("one"), { theme: null });
    assert.deepEqual(await accountTheme(domain, actor("one")), { theme: null });
    assert.equal(
      (await domain.query("SELECT * FROM domain.account_preferences")).rows
        .length,
      0,
    );
  });
});
