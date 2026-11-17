import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import sharp from "sharp";
import { initializeOperator } from "../../scripts/lib/initialize-operator.ts";
import { saveUnitCalendar } from "../../src/modules/catalog/calendar-store.ts";
import type { AuthenticatedAccount } from "../../src/modules/identity/auth.ts";
import {
  renameMunicipality,
  saveLogo,
} from "../../src/modules/identity/branding.ts";
import { saveNotice } from "../../src/modules/identity/legal-notices.ts";
import {
  acceptManager,
  inviteManager,
} from "../../src/modules/identity/manager.ts";
import { saveAccountPreferences } from "../../src/modules/identity/preferences.ts";
import { createBlock } from "../../src/modules/reservations/blocks.ts";
import { replaceCalendarSubscription } from "../../src/modules/reservations/calendar-subscription.ts";
import { cancelReservation } from "../../src/modules/reservations/cancel.ts";
import { createReservation } from "../../src/modules/reservations/create.ts";
import { backdateBookings } from "./backdate.ts";
import {
  account,
  administrator,
  localDate,
  type MunicipalitySeed,
  ribasanta,
  seedDemo,
  timeZone,
  type UnitSeed,
  valdeira,
  zoned,
} from "./seed.ts";

// A demonstration installation that looks used: two municipalities with their
// own identity, staff with every role, fourteen weeks of history behind the
// analytics (so that a month and 30 days compare with the period before), a
// busy next fortnight, closures, a block, legal pages and notices. Every write
// goes through the application modules except what can only be backdated
// (creation, acceptance, event, notice and arrival times), which uses the
// migration pool. Nothing seeded happens after the seeding itself.

interface Pools {
  auth: Pool;
  domain: Pool;
  migration: Pool;
}
interface Options {
  origin: string;
  password: string;
}
interface Reserved {
  tenantId: string;
  id: string;
  revision: number;
  holder: Staff;
  startsAt: Date;
  bookedAt: Date;
}
type Staff = AuthenticatedAccount;

const hour = 3600000;
const day = 24 * hour;
const retention = 3600;
/** Days of history: covers the previous calendar month and the one before it. */
const history = 98;

/** Deterministic pseudo-random sequence: every installation gets the same history. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function weekday(date: string) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(new Date(`${date}T12:00:00Z`));
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name) + 1;
}

/** Whole-hour starts whose `minutes` fit inside the unit's opening that day. */
function starts(unit: UnitSeed, date: string, minutes: number) {
  const day = weekday(date);
  return unit.weekly
    .filter((opening) => opening.days.includes(day))
    .flatMap(({ startMinute, endMinute }) => {
      const hours: number[] = [];
      for (let start = startMinute; start + minutes <= endMinute; start += 60)
        if (start % 60 === 0 && start / 60 < 24) hours.push(start / 60);
      return hours;
    });
}

/** Evening and weekend demand, as a sports facility actually sees it. */
function demand(hour: number, date: string) {
  const weekend = weekday(date) >= 6;
  if (hour >= 18 && hour < 22) return weekend ? 0.55 : 0.75;
  if (hour >= 16) return weekend ? 0.55 : 0.4;
  if (hour >= 10) return weekend ? 0.5 : 0.18;
  return 0.12;
}

function units(seed: MunicipalitySeed) {
  return seed.facilities.flatMap((facility) => facility.units);
}

/** A 512 px emblem rendered from SVG, as an administrator would upload it. */
async function emblem(color: string, letter: string, stroke: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <path d="M256 24 L456 92 V246 C456 366 372 446 256 488 C140 446 56 366 56 246 V92 Z" fill="${color}" stroke="${stroke}" stroke-width="18"/>
  <path d="M120 318 C170 286 214 350 256 318 C298 286 342 350 392 318" fill="none" stroke="${stroke}" stroke-width="16" stroke-linecap="round"/>
  <text x="256" y="262" font-family="DejaVu Serif, serif" font-size="190" font-weight="700" text-anchor="middle" fill="${stroke}">${letter}</text>
</svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

function legalPages(name: string, taxId: string, address: string) {
  const contact = `Rexistro electrónico do ${name} e correo ${name.toLowerCase().replaceAll(" ", "")}@demo.test`;
  return {
    privacy: {
      gl: {
        controller: name,
        controllerContact: contact,
        dpo: "Delegación de protección de datos da Deputación (servizo compartido)",
        purposes:
          "Xestionar as contas e as reservas das instalacións deportivas municipais e enviar os avisos asociados.",
        legalBasis:
          "Exercicio de poderes públicos e cumprimento de obrigas legais (art. 6.1.c e 6.1.e RXPD).",
        recipients: "Non se ceden datos a terceiros salvo obriga legal.",
        retention:
          "As reservas consérvanse un ano despois da súa data; a conta, mentres permaneza activa.",
        rights:
          "Acceso, rectificación, supresión, limitación e oposición ante o rexistro municipal.",
        complaint: "Axencia Española de Protección de Datos (www.aepd.es).",
      },
      es: {
        controller: name,
        controllerContact: contact,
        dpo: "Delegación de protección de datos de la Diputación (servicio compartido)",
        purposes:
          "Gestionar las cuentas y las reservas de las instalaciones deportivas municipales y enviar los avisos asociados.",
        legalBasis:
          "Ejercicio de poderes públicos y cumplimiento de obligaciones legales (art. 6.1.c y 6.1.e RGPD).",
        recipients: "No se ceden datos a terceros salvo obligación legal.",
        retention:
          "Las reservas se conservan un año después de su fecha; la cuenta, mientras permanezca activa.",
        rights:
          "Acceso, rectificación, supresión, limitación y oposición ante el registro municipal.",
        complaint: "Agencia Española de Protección de Datos (www.aepd.es).",
      },
    },
    legal: {
      gl: { entity: name, taxId, address, contact },
      es: { entity: name, taxId, address, contact },
    },
    accessibility: {
      status: "partial" as const,
      preparedOn: "2026-10-01",
      reviewedOn: "2026-11-01",
      gl: {
        nonAccessible:
          "As fotografías das instalacións anteriores a 2026 poden non ter unha descrición completa.",
        evaluation: "Autoavaliación segundo a norma UNE-EN 301549:2022.",
        feedback: `Comunicacións de accesibilidade: ${contact}.`,
        enforcement:
          "Se a resposta non é satisfactoria, pódese presentar unha reclamación ante a unidade responsable de accesibilidade.",
      },
      es: {
        nonAccessible:
          "Las fotografías de las instalaciones anteriores a 2026 pueden no tener una descripción completa.",
        evaluation: "Autoevaluación según la norma UNE-EN 301549:2022.",
        feedback: `Comunicaciones de accesibilidad: ${contact}.`,
        enforcement:
          "Si la respuesta no es satisfactoria, se puede presentar una reclamación ante la unidad responsable de accesibilidad.",
      },
    },
  };
}

const citizens = [
  ["xian.lopez@demo.test", "Xián López Varela"],
  ["noa.fernandez@demo.test", "Noa Fernández Rial"],
  ["iago.castro@demo.test", "Iago Castro Pazos"],
  ["sabela.rodriguez@demo.test", "Sabela Rodríguez Mouriño"],
  ["martin.garcia@demo.test", "Martín García Otero"],
  ["uxia.vazquez@demo.test", "Uxía Vázquez Lema"],
  ["anxo.dominguez@demo.test", "Anxo Domínguez Seoane"],
  ["carme.souto@demo.test", "Carme Souto Barreiro"],
] as const;

export async function seedCloudDemo(
  app: FastifyInstance,
  { auth, domain, migration }: Pools,
  { origin, password }: Options,
) {
  const startedAt = new Date();
  const base = await seedDemo(app, auth, domain, migration, origin, password);
  let address = 50;
  const person = async (email: string, name: string, mfa: boolean) => {
    const created = await account(
      app,
      auth,
      origin,
      `198.51.100.${address++}`,
      email,
      name,
      mfa,
      password,
    );
    const actor: Staff = {
      accountId: created.accountId,
      email,
      sessionId: "demo-seed",
      mfaVerifiedAt: mfa ? new Date() : null,
      mfaEnabled: mfa,
    };
    return { ...created, name, actor };
  };
  const idOf = async (email: string) =>
    (
      await auth.query<{ id: string }>(
        'SELECT id FROM auth."user" WHERE email=$1',
        [email],
      )
    ).rows[0]?.id as string;
  // Staff commands check MFA freshness on the actor; roles still come from the database.
  const staff = (accountId: string, email: string): Staff => ({
    accountId,
    email,
    sessionId: "demo-seed",
    mfaVerifiedAt: new Date(),
    mfaEnabled: true,
  });
  const marta = staff(await idOf(base.administrator), base.administrator);
  const lucia: Staff = {
    accountId: await idOf(base.citizen),
    email: base.citizen,
    sessionId: "demo-seed",
    mfaVerifiedAt: null,
  };

  // Platform operator, Ribasanta administrator and a Valdeira manager.
  const operator = await person(
    "operacion@quenda.demo.test",
    "Equipo de operación de Quenda",
    true,
  );
  const client = await migration.connect();
  try {
    await initializeOperator(
      client as unknown as Parameters<typeof initializeOperator>[0],
      operator.accountId,
    );
  } finally {
    client.release();
  }
  const xoan = await person(
    "administracion@ribasanta.demo.test",
    "Xoán Vilar Iglesias",
    true,
  );
  await administrator(migration, ribasanta.id, xoan.accountId);
  const brais = await person(
    "xestion@valdeira.demo.test",
    "Brais Otero Fraga",
    true,
  );
  const { invitationId } = (await inviteManager(domain, marta, valdeira.id, {
    accountId: brais.accountId,
    expiresAt: new Date(Date.now() + 7 * day).toISOString(),
    permissions: [
      { operation: "RESERVATION_READ", unitId: null },
      { operation: "RESERVATION_MANAGE", unitId: null },
      { operation: "UNIT_BLOCK", unitId: null },
      { operation: "REPORT_READ", unitId: null },
    ],
  } as Parameters<typeof inviteManager>[3])) as { invitationId: string };
  await acceptManager(domain, brais.actor, valdeira.id, invitationId);

  // Municipal identity: display name and logos. The appearance keeps the
  // Quenda default; each administration chooses its theme from Apariencia.
  const identity = [
    {
      seed: valdeira,
      admin: marta,
      name: "Concello de Valdeira",
      light: await emblem("#0f4c81", "V", "#ffffff"),
      dark: await emblem("#e8f1fa", "V", "#0f4c81"),
    },
    {
      seed: ribasanta,
      admin: xoan.actor,
      name: "Concello de Ribasanta",
      light: await emblem("#6b1f3a", "R", "#ffffff"),
      dark: null,
    },
  ];
  for (const entry of identity) {
    await renameMunicipality(
      domain,
      entry.admin,
      entry.seed.id,
      { expectedVersion: 1, name: entry.name },
      randomUUID(),
    );
    await saveLogo(
      domain,
      entry.admin,
      entry.seed.id,
      "light",
      { expectedVersion: 2, image: entry.light },
      randomUUID(),
    );
    if (entry.dark)
      await saveLogo(
        domain,
        entry.admin,
        entry.seed.id,
        "dark",
        { expectedVersion: 3, image: entry.dark },
        randomUUID(),
      );
  }

  // Legal pages of each municipality.
  const pages = [
    [
      valdeira.id,
      marta,
      legalPages(
        "Concello de Valdeira",
        "P1500000A",
        "Praza do Concello 1, 15000 Valdeira",
      ),
    ],
    [
      ribasanta.id,
      xoan.actor,
      legalPages(
        "Concello de Ribasanta",
        "P1500001B",
        "Rúa Real 4, 15001 Ribasanta",
      ),
    ],
  ] as const;
  for (const [tenantId, actor, notices] of pages)
    for (const kind of ["privacy", "legal", "accessibility"] as const)
      await saveNotice(domain, actor, tenantId, kind, {
        expectedVersion: 0,
        body: notices[kind],
      });

  // Floor maintenance in the main court next week.
  const court = units(valdeira).find((unit) => unit.name === "Pista central");
  if (court) {
    const date = localDate(8);
    await createBlock(
      domain,
      brais.actor,
      valdeira.id,
      randomUUID(),
      {
        unitId: court.id,
        startsAt: zoned(date, 10),
        endsAt: zoned(date, 13),
        reason: "Mantemento do parqué",
      },
      randomUUID(),
      retention,
    );
  }

  // Residents: the demo citizen plus eight more.
  const holders: Staff[] = [lucia];
  for (const [email, name] of citizens)
    holders.push((await person(email, name, false)).actor);

  const draw = random(20261116);
  const now = Date.now();
  // A booking `lead` before its start, or in the last days when that is still
  // ahead: everything seeded was booked before the seeding.
  const bookedBefore = (startsAt: Date, lead: number) => {
    const planned = startsAt.getTime() - lead;
    return new Date(
      planned < now - hour ? planned : now - (0.1 + draw() * 2.9) * day,
    );
  };
  const reserved: Reserved[] = [];
  let skipped = 0;
  const reserve = async (
    tenantId: string,
    unitId: string,
    holder: Staff,
    startsAt: Date,
    minutes: number,
    bookedAt: Date,
  ) => {
    try {
      const { result } = await createReservation(
        domain,
        holder,
        tenantId,
        randomUUID(),
        {
          unitId,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + minutes * 60000).toISOString(),
          acceptance: {
            usageRulesVersion: 1,
            bookingPolicyVersion: 1,
            nonCancellable: false,
          },
        },
        randomUUID(),
        retention,
        { now: () => bookedAt },
      );
      const entry = {
        tenantId,
        id: result.id as string,
        revision: result.revision as number,
        holder,
        startsAt,
        bookedAt,
      };
      reserved.push(entry);
      return entry;
    } catch {
      // A slot the base dataset already took, or a holder limit: leave it free.
      skipped++;
      return null;
    }
  };

  // A regular: Lucía plays padel every Tuesday at 19:00 (recommendations).
  const padel = valdeira.facilities[0]?.units[0] as UnitSeed;
  const horizon = now + 26 * hour;
  for (let offset = -history; offset <= 21; offset++) {
    const date = localDate(offset);
    if (weekday(date) !== 2) continue;
    const startsAt = new Date(zoned(date, 19));
    if (startsAt.getTime() < horizon && offset >= 0) continue;
    await reserve(
      valdeira.id,
      padel.id,
      lucia,
      startsAt,
      90,
      bookedBefore(startsAt, 5 * day),
    );
  }

  // Fourteen weeks of history and the next three weeks, unit by unit.
  for (const seed of [valdeira, ribasanta])
    for (const unit of units(seed))
      for (let offset = -history; offset <= 21; offset++) {
        const date = localDate(offset);
        const future = offset >= 0;
        for (const hour of starts(unit, date, 60)) {
          const startsAt = new Date(zoned(date, hour));
          if (future && startsAt.getTime() < horizon) continue;
          if (!future && startsAt.getTime() > now - 2 * 3600000) continue;
          // History grows gently over the weeks, so consecutive months stay
          // comparable; the future is half-booked so far.
          const trend = future
            ? 0.55
            : 0.9 + (0.1 * (offset + history)) / history;
          const share = seed === ribasanta ? 0.6 : 1;
          if (draw() > demand(hour, date) * trend * share) continue;
          const bookedAt = bookedBefore(startsAt, (1.2 + draw() * 8) * day);
          await reserve(
            seed.id,
            unit.id,
            holders[Math.floor(draw() * holders.length)] as Staff,
            startsAt,
            60,
            bookedAt,
          );
        }
      }

  // Cancellations: some by residents in time, a few by the municipality,
  // hours or days after the booking, before its deadline and before now.
  const cancelledAt = new Map<string, Date>();
  for (const entry of reserved) {
    const roll = draw();
    const earliest = entry.bookedAt.getTime() + 2 * hour;
    const latest = Math.min(
      entry.startsAt.getTime() - 25 * hour,
      now - 15 * 60000,
    );
    if (roll > 0.13 || latest <= earliest) continue;
    const at = new Date(earliest + draw() * (latest - earliest));
    const administrative = roll < 0.02 && entry.tenantId === valdeira.id;
    try {
      await cancelReservation(
        domain,
        administrative ? brais.actor : entry.holder,
        entry.tenantId,
        entry.id,
        randomUUID(),
        administrative
          ? {
              expectedRevision: entry.revision,
              administrative: true,
              reason: "Competición escolar no complexo",
            }
          : { expectedRevision: entry.revision },
        randomUUID(),
        retention,
        { now: () => at },
      );
      cancelledAt.set(entry.id, at);
    } catch {
      skipped++;
    }
  }

  // Holiday closures and reduced hours in Valdeira's next calendar version,
  // saved after the bookings so that they were made under the first one.
  const year = Number(localDate(0).slice(0, 4));
  const exceptions = [
    {
      date: `${year}-12-24`,
      intervals: [{ startMinute: 540, endMinute: 840 }],
    },
    { date: `${year}-12-25`, intervals: [] },
    {
      date: `${year}-12-31`,
      intervals: [{ startMinute: 540, endMinute: 840 }],
    },
    { date: `${year + 1}-01-01`, intervals: [] },
    { date: `${year + 1}-01-06`, intervals: [] },
  ];
  for (const unit of units(valdeira))
    await saveUnitCalendar(domain, marta, valdeira.id, unit.id, {
      expectedVersion: 1,
      reason: "Festivos de Nadal e Reis",
      calendar: {
        minimumMinutes: unit.minimum,
        maximumMinutes: unit.maximum,
        stepMinutes: unit.step,
        advanceDays: null,
        weekly: unit.weekly.flatMap(({ days, startMinute, endMinute }) =>
          days.map((weekdayNumber) => ({
            day: weekdayNumber,
            startMinute,
            endMinute,
          })),
        ),
        exceptions,
      },
    });

  // The base dataset's own bookings were made just now: spread them over the
  // last days too. A non-cancellable booking stays inside its deadline.
  const { rows: recent } = await migration.query<{
    id: string;
    status: string;
    non_cancellable_accepted: boolean;
  }>(
    `SELECT id, status, non_cancellable_accepted FROM domain.reservation
      WHERE created_at >= $1 AND NOT id = ANY($2::uuid[]) ORDER BY starts_at, id`,
    [startedAt, reserved.map((entry) => entry.id)],
  );
  const baseHistory = recent.map((row) => {
    const bookedAt = new Date(
      row.non_cancellable_accepted
        ? now - (0.5 + draw() * 1.5) * hour
        : now - (0.3 + draw() * 2.7) * day,
    );
    const span = now - 10 * 60000 - (bookedAt.getTime() + 2 * hour);
    return {
      id: row.id,
      bookedAt,
      cancelledAt:
        row.status === "CANCELADA" && span > 0
          ? new Date(bookedAt.getTime() + 2 * hour + draw() * span)
          : null,
    };
  });
  // Backdate what the database stamped with the seeding time.
  await backdateBookings(migration, [
    ...reserved.map((entry) => ({
      id: entry.id,
      bookedAt: entry.bookedAt,
      cancelledAt: cancelledAt.get(entry.id) ?? null,
    })),
    ...baseHistory,
  ]);
  // Staff recorded arrival at most past reservations.
  await migration.query(
    `UPDATE domain.reservation SET
        arrived_at=starts_at - (random() * interval '10 minutes'),
        arrival_recorded_by=CASE WHEN tenant_id=$1 THEN $2 ELSE $3 END
      WHERE status='CONFIRMADA' AND ends_at < now() AND random() < 0.82`,
    [valdeira.id, brais.accountId, xoan.accountId],
  );
  // Seeded events are history, never mail: the worker must not deliver them.
  await migration.query(
    "UPDATE domain.reservation_email SET accepted_at=created_at WHERE accepted_at IS NULL",
  );

  // The resident's account: language and a calendar subscription.
  await saveAccountPreferences(domain, lucia, "gl");
  const calendar = await replaceCalendarSubscription(
    domain,
    lucia,
    origin,
    "gl",
  );

  process.stderr.write(
    `Seeded ${reserved.length} reservations (${cancelledAt.size} cancelled, ${skipped} skipped)\n`,
  );
  const totp = (email: string, secret: string | null) =>
    secret
      ? `otpauth://totp/Quenda:${encodeURIComponent(email)}?secret=${secret}&issuer=Quenda`
      : null;
  return {
    version: 1,
    origin,
    password,
    accounts: [
      {
        role: "Operación de la plataforma",
        email: operator.email,
        totp: totp(operator.email, operator.secret),
      },
      {
        role: "Administración de Valdeira",
        email: base.administrator,
        totp: totp(base.administrator, base.administratorSecret),
      },
      {
        role: "Gestión de reservas de Valdeira",
        email: brais.email,
        totp: totp(brais.email, brais.secret),
      },
      {
        role: "Administración de Ribasanta",
        email: xoan.email,
        totp: totp(xoan.email, xoan.secret),
      },
      { role: "Vecina (reserva habitual)", email: base.citizen, totp: null },
      ...citizens.map(([email]) => ({ role: "Vecino/a", email, totp: null })),
    ],
    calendarSubscription: calendar,
  };
}
