import assert from "node:assert/strict";
import test from "node:test";
import {
  addressLine,
  kindName,
  localized,
  mapLink,
  unitFacts,
} from "../src/features/catalog/profile.ts";

test("text follows the active language and falls back to the other co-official one", () => {
  const value = { gl: "Pavillón", es: "Pabellón" };
  assert.equal(localized(value, "gl"), "Pavillón");
  assert.equal(localized(value, "es"), "Pabellón");
  assert.equal(localized({ es: "Solo castellano" }, "gl"), "Solo castellano");
  assert.equal(localized({ gl: "  " }, "es"), undefined);
  assert.equal(localized(undefined, "es"), undefined);
});

test("the address line joins what exists and is absent when nothing was written", () => {
  assert.equal(
    addressLine({ address: "Rúa do Mar 4", postalCode: "15001" }),
    "Rúa do Mar 4, 15001",
  );
  assert.equal(addressLine({ postalCode: "15001" }), "15001");
  assert.equal(addressLine({}), undefined);
  assert.equal(addressLine(undefined), undefined);
});

test("the map link is a plain OpenStreetMap address with the exact coordinates", () => {
  const url = new URL(mapLink({ latitude: 43.362346, longitude: -8.4115 }));
  assert.equal(url.origin, "https://www.openstreetmap.org");
  assert.equal(url.searchParams.get("mlat"), "43.362346");
  assert.equal(url.searchParams.get("mlon"), "-8.4115");
});

test("unit facts are localized and skip what is unknown", () => {
  assert.deepEqual(
    unitFacts({ kind: "padel", indoor: false, capacity: 4 }, "es"),
    ["Pista de pádel", "Al aire libre", "Hasta 4 personas"],
  );
  assert.deepEqual(unitFacts({ kind: "pabellon", indoor: true }, "gl"), [
    "Pavillón",
    "Cuberto",
  ]);
  assert.deepEqual(unitFacts({}, "es"), []);
  assert.deepEqual(unitFacts(undefined, "gl"), []);
  assert.equal(kindName("gimnasio", "gl"), "Ximnasio");
});
