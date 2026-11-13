import assert from "node:assert/strict";
import test from "node:test";
import { landingSection } from "../src/features/municipal/landing.ts";

const grant = (operation: string, unitId: string | null = null) => ({
  operation,
  unitId,
});
const authority = (
  permissions: ReturnType<typeof grant>[],
  administrator = false,
) => ({ administrator, permissions });

test("the landing section follows the permissions actually held", () => {
  assert.equal(landingSection(authority([], true)), "");
  assert.equal(landingSection(authority([grant("CATALOG_MANAGE")])), "");
  assert.equal(
    landingSection(authority([grant("RESERVATION_READ")])),
    "/agenda",
  );
  assert.equal(
    landingSection(authority([grant("REPORT_READ")])),
    "/uso-de-los-espacios",
  );
  assert.equal(
    landingSection(authority([grant("PRIVACY_READ")])),
    "/privacidad",
  );
});

test("a unit-scoped privacy grant opens nothing and no grant means no landing", () => {
  assert.equal(
    landingSection(authority([grant("PRIVACY_READ", "unit")])),
    null,
  );
  assert.equal(landingSection(authority([])), null);
});
