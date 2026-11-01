import assert from "node:assert/strict";
import test from "node:test";
import type { Navigation } from "../src/app/api.ts";
import { staffEntry } from "../src/app/staff-scope.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const municipality = {
  id: tenant,
  name: "Oleiros",
  administrator: false,
  permissions: [{ operation: "AGENDA_READ", unitId: null }],
};
function navigation(
  items: Navigation["municipalities"]["items"],
  platform: Navigation["platform"] = { operator: false, permissions: [] },
  nextCursor: string | null = null,
): Navigation {
  return { municipalities: { items, nextCursor }, platform };
}

test("people without delegated scope get no management entry", () => {
  assert.equal(staffEntry(navigation([])), null);
});

test("a single municipality opens its administration directly", () => {
  assert.equal(
    staffEntry(navigation([municipality])),
    `/administracion/${tenant}`,
  );
});

test("several municipalities or platform scope open the picker", () => {
  assert.equal(
    staffEntry(navigation([municipality, { ...municipality, id: "x" }])),
    "/administracion",
  );
  assert.equal(
    staffEntry(navigation([municipality], undefined, "next")),
    "/administracion",
  );
  assert.equal(
    staffEntry(
      navigation([], { operator: false, permissions: ["PRIVACY_READ"] }),
    ),
    "/administracion",
  );
  assert.equal(
    staffEntry(navigation([municipality], { operator: true, permissions: [] })),
    "/administracion",
  );
});
