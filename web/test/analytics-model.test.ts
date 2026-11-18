import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsCsv,
  compare,
  comparisonName,
  daySummary,
  defaultView,
  demand,
  highlights,
  metricSuffix,
  parseView,
  peak,
  peakText,
  periodName,
  presetPeriod,
  previousPeriod,
  serviceCells,
  serviceSlots,
  slotLabels,
  type UsageAnalytics,
  validPeriod,
} from "../src/features/analytics/model.ts";

const es = (spanish: string) => spanish;
const gl = (_spanish: string, galician: string) => galician;

test("presets end today and last month is the whole previous calendar month", () => {
  // Thursday 12 November 2026.
  const today = "2026-11-12";
  assert.deepEqual(presetPeriod("THIS_WEEK", today), {
    from: "2026-11-09",
    to: "2026-11-13",
  });
  assert.deepEqual(presetPeriod("THIS_MONTH", today), {
    from: "2026-11-01",
    to: "2026-11-13",
  });
  assert.deepEqual(presetPeriod("LAST_MONTH", today), {
    from: "2026-10-01",
    to: "2026-11-01",
  });
  assert.deepEqual(presetPeriod("LAST_30_DAYS", today), {
    from: "2026-10-14",
    to: "2026-11-13",
  });
  // A Monday starts its own week; January looks back to December.
  assert.equal(presetPeriod("THIS_WEEK", "2026-11-09").from, "2026-11-09");
  assert.deepEqual(presetPeriod("LAST_MONTH", "2027-01-05"), {
    from: "2026-12-01",
    to: "2027-01-01",
  });
});

test("periods are whole days up to 366 days", () => {
  assert.ok(validPeriod({ from: "2026-01-01", to: "2027-01-01" }));
  assert.ok(!validPeriod({ from: "2026-01-01", to: "2027-01-03" }));
  assert.ok(!validPeriod({ from: "2026-02-01", to: "2026-02-01" }));
  assert.ok(!validPeriod({ from: "2026-02-30", to: "2026-03-02" }));
});

test("the comparison uses the previous months for whole months and the previous days otherwise", () => {
  assert.deepEqual(previousPeriod({ from: "2026-10-01", to: "2026-11-01" }), {
    from: "2026-09-01",
    to: "2026-10-01",
    kind: "months",
  });
  assert.deepEqual(previousPeriod({ from: "2026-01-01", to: "2026-04-01" }), {
    from: "2025-10-01",
    to: "2026-01-01",
    kind: "months",
  });
  assert.deepEqual(previousPeriod({ from: "2026-11-01", to: "2026-11-13" }), {
    from: "2026-10-20",
    to: "2026-11-01",
    kind: "days",
  });
  assert.equal(
    comparisonName({ from: "2026-10-01", to: "2026-11-01" }, es),
    "frente a septiembre",
  );
  assert.equal(
    comparisonName({ from: "2026-01-01", to: "2026-02-01" }, gl),
    "fronte a decembro 2025",
  );
  assert.equal(
    comparisonName({ from: "2026-11-01", to: "2026-11-13" }, es),
    "frente a los 12 días anteriores",
  );
  assert.equal(
    comparisonName({ from: "2026-11-12", to: "2026-11-13" }, gl),
    "fronte ao día anterior",
  );
});

test("periods and series buckets read as plain dates", () => {
  assert.equal(
    periodName({ from: "2026-11-03", to: "2026-11-10" }, "es"),
    "del 3 al 9 de noviembre de 2026",
  );
  assert.equal(
    periodName({ from: "2026-10-28", to: "2026-11-04" }, "gl"),
    "do 28 de outubro de 2026 ao 3 de novembro de 2026",
  );
  assert.equal(
    periodName({ from: "2026-11-03", to: "2026-11-04" }, "es"),
    "3 de noviembre de 2026",
  );
  assert.equal(
    slotLabels({ from: "2026-11-03", to: "2026-11-04" }, "day", "es").axisLabel,
    "3 nov",
  );
  assert.equal(
    slotLabels({ from: "2026-10-01", to: "2026-11-01" }, "month", "gl").label,
    "outubro 2026",
  );
});

test("changes are told in points for rates and relative for amounts, never by colour alone", () => {
  assert.deepEqual(compare(47, 41, "points", es, "es"), {
    text: "6 puntos",
    direction: "up",
    tone: "positive",
  });
  assert.deepEqual(compare(9, 11, "points", es, "es", true), {
    text: "2 puntos",
    direction: "down",
    tone: "positive",
  });
  assert.deepEqual(compare(110, 100, "relative", gl, "gl"), {
    text: "10 %",
    direction: "up",
    tone: "positive",
  });
  assert.equal(compare(40.2, 40.4, "points", es, "es")?.text, "Sin cambios");
  assert.equal(compare(5, 0, "relative", es, "es")?.text, "Nuevo");
  assert.equal(compare(null, 10, "points", es, "es"), undefined);
  assert.equal(compare(10, undefined, "points", es, "es"), undefined);
});

test("demand labels follow the municipal thresholds", () => {
  const settings = { highDemandPercent: 85, lowUsePercent: 20 };
  assert.equal(demand(85, settings), "high");
  assert.equal(demand(84.9, settings), null);
  assert.equal(demand(19.9, settings), "low");
  assert.equal(demand(20, settings), null);
  assert.equal(demand(null, settings), null);
});

const cell = (weekday: number, hour: number, occupancyPercent: number) => ({
  weekday,
  hour,
  offeredMinutes: 60,
  reservedMinutes: (60 * occupancyPercent) / 100,
  occupancyPercent,
});
function analytics(overrides: Partial<UsageAnalytics> = {}): UsageAnalytics {
  return {
    tenantId: "t",
    unitId: null,
    from: "2026-11-01",
    to: "2026-11-08",
    timeZone: "Europe/Madrid",
    asOf: "2026-11-08T10:00:00Z",
    granularity: "day",
    summary: {
      reservations: { CONFIRMADA: 1, CANCELADA: 1, FINALIZADA: 8 },
      reservedMinutes: 600,
      offeredMinutes: 1200,
      occupancyPercent: 50,
    },
    series: [
      {
        from: "2026-11-01",
        to: "2026-11-02",
        offeredMinutes: 1200,
        reservedMinutes: 600,
        occupancyPercent: 50,
        reservations: 10,
        cancelled: 1,
      },
    ],
    weekdayHours: [
      cell(2, 17, 60),
      cell(2, 18, 92),
      cell(2, 19, 90),
      cell(3, 18, 40),
    ],
    units: [
      {
        unitId: "a",
        name: "Pista 2",
        facilityId: "f",
        facilityName: "Pabellón Norte",
        offeredMinutes: 600,
        reservedMinutes: 546,
        occupancyPercent: 91,
        reservations: 9,
        cancelled: 1,
        trend: [91],
      },
      {
        unitId: "b",
        name: "=Calle 3",
        facilityId: "g",
        facilityName: "Piscina",
        offeredMinutes: 600,
        reservedMinutes: 54,
        occupancyPercent: 9,
        reservations: 1,
        cancelled: 0,
        trend: [9],
      },
    ],
    cancellations: {
      reservations: 10,
      cancelled: 1,
      byHolder: 1,
      administrative: 0,
      cancelledPercent: 10,
    },
    leadTime: {
      lessThanOneDay: 1,
      oneToThreeDays: 2,
      threeToSevenDays: 3,
      sevenToFourteenDays: 2,
      fourteenDaysOrMore: 2,
    },
    attendance: { finished: 8, arrived: 6, arrivedPercent: 75 },
    ...overrides,
  };
}

test("the busiest stretch joins neighbouring hours of the same day", () => {
  assert.deepEqual(peak(analytics().weekdayHours), {
    weekday: 2,
    start: 18,
    end: 20,
    occupancyPercent: 92,
  });
  assert.equal(peak([]), undefined);
});

test("hours after midnight belong to the service day before, so Friday night stays on Friday", () => {
  const cells = serviceCells([
    cell(6, 0, 100),
    cell(1, 3, 50),
    cell(5, 23, 40),
  ]);
  assert.deepEqual(
    cells.map(({ day, slot }) => ({ day, slot })),
    [
      { day: 5, slot: 24 },
      { day: 7, slot: 27 },
      { day: 5, slot: 23 },
    ],
  );
  assert.deepEqual(serviceSlots(cells), [23, 24, 25, 26, 27]);
  assert.deepEqual(
    serviceSlots(serviceCells([cell(2, 9, 0), cell(2, 11, 0)])),
    [9, 10, 11],
  );
  assert.deepEqual(serviceSlots([]), []);
});

test("an hour that was barely open cannot be the peak, and a busy late night is named as the night before", () => {
  const spill = { ...cell(6, 0, 100), offeredMinutes: 10, reservedMinutes: 10 };
  const evening = [cell(5, 20, 70), cell(5, 21, 60), cell(5, 22, 30)];
  assert.deepEqual(peak([spill, ...evening]), {
    weekday: 5,
    start: 20,
    end: 21,
    occupancyPercent: 70,
  });
  assert.equal(
    peakText([cell(6, 0, 95), cell(6, 1, 92), ...evening], es, "es"),
    "La franja con más demanda es la noche del viernes, de 00:00 a 02:00 (95 %).",
  );
  assert.equal(
    peakText([cell(5, 23, 90), cell(6, 0, 88), ...evening], gl, "gl"),
    "A franxa con máis demanda é o venres de 23:00 a 01:00 (90 %).",
  );
});

test("a day summary adds up the service day and names its busiest representative hour", () => {
  const cells = serviceCells([
    cell(5, 18, 50),
    cell(5, 19, 100),
    { ...cell(6, 0, 100), offeredMinutes: 10, reservedMinutes: 10 },
    cell(6, 10, 20),
  ]);
  const friday = daySummary(cells, 5);
  assert.equal(friday.offeredMinutes, 130);
  assert.equal(friday.reservedMinutes, 100);
  assert.equal(friday.occupancyPercent, 77);
  assert.equal(friday.busiest?.slot, 19);
  assert.equal(daySummary(cells, 1).occupancyPercent, null);
  assert.equal(daySummary(cells, 1).busiest, undefined);
});

test("highlights state the change, the busiest space, little-used spaces and peak hours", () => {
  const current = analytics();
  const previous = analytics({
    summary: { ...current.summary, occupancyPercent: 41 },
  });
  const settings = { highDemandPercent: 85, lowUsePercent: 20 };
  assert.deepEqual(
    highlights({
      current,
      previous,
      comparison: "frente a octubre",
      settings,
      t: es,
      locale: "es",
    }),
    [
      "La ocupación subió del 41 % al 50 % frente a octubre.",
      "El espacio con más demanda es «Pista 2 · Pabellón Norte» (91 %).",
      "1 espacio tuvo poco uso (menos del 20 %).",
      "La franja con más demanda es el martes de 18:00 a 20:00 (92 %).",
    ],
  );
  assert.deepEqual(
    highlights({
      current: analytics({
        summary: { ...current.summary, offeredMinutes: 0 },
        cancellations: { ...current.cancellations, reservations: 0 },
      }),
      comparison: "",
      settings,
      t: gl,
      locale: "gl",
    }),
    ["Non houbo horario ofertado nin reservas neste período."],
  );
});

test("the personal view keeps only known choices", () => {
  assert.deepEqual(parseView(null), defaultView);
  assert.deepEqual(parseView("not json"), defaultView);
  assert.deepEqual(parseView("[1,2]"), defaultView);
  const view = parseView(
    JSON.stringify({
      evolution: "bars",
      granularity: "year",
      previous: false,
      demandMetric: "hours",
      blocks: { evolution: false, demand: "no" },
      display: "table",
    }),
  );
  assert.deepEqual(view, {
    evolution: "bars",
    granularity: "auto",
    previous: false,
    demandMetric: "hours",
    blocks: { evolution: false, demand: true, compliance: true },
    display: "table",
  });
});

test("the summary sheet lists totals, series and spaces without formulas", () => {
  const sheet = analyticsCsv(analytics(), es);
  const lines = sheet.trimEnd().split("\r\n");
  assert.equal(lines.length, 1 + 1 + 1 + 2);
  assert.equal(lines[1], "Total,2026-11-01,2026-11-08,,,20,10,50,10,1");
  assert.equal(
    lines[3],
    "Espacio,2026-11-01,2026-11-08,Pista 2,Pabellón Norte,10,9.1,91,9,1",
  );
  // A name that starts like a formula is neutralised for spreadsheets.
  assert.ok(lines[4]?.includes(",'=Calle 3,"));
});

test("without opening hours the highlights still say how many reservations started", () => {
  const current = analytics({
    summary: {
      reservations: { CONFIRMADA: 1, CANCELADA: 0, FINALIZADA: 0 },
      reservedMinutes: 60,
      offeredMinutes: 0,
      occupancyPercent: null,
    },
    units: [],
    weekdayHours: [],
    cancellations: {
      reservations: 1,
      cancelled: 0,
      byHolder: 0,
      administrative: 0,
      cancelledPercent: 0,
    },
  });
  assert.deepEqual(
    highlights({
      current,
      previous: analytics({
        cancellations: { ...current.cancellations, reservations: 3 },
      }),
      comparison: "fronte aos 7 días anteriores",
      settings: { highDemandPercent: 85, lowUsePercent: 20 },
      t: gl,
      locale: "gl",
    }),
    [
      "Non houbo horario ofertado neste período, así que a ocupación non se pode calcular.",
      "1 reserva comezou neste período (3 fronte aos 7 días anteriores).",
    ],
  );
});

test("summary figures separate their unit with a no-break space", () => {
  assert.equal(metricSuffix("%"), "\u00a0%");
  assert.equal(metricSuffix("h"), "\u00a0h");
});
