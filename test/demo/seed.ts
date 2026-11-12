import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { processPhoto } from "../../src/modules/catalog/photo-image.ts";
import { cancelReservation } from "../../src/modules/reservations/cancel.ts";
import { createReservation } from "../../src/modules/reservations/create.ts";
import { browser, totp } from "../helpers/auth-client.ts";

// Representative content for visual review. It lives in its own ephemeral
// database and never shares municipalities or accounts with automated tests.

const timeZone = "Europe/Madrid";
const password = "Demostracion-quenda-2026";

interface Opening {
  days: number[];
  startMinute: number;
  endMinute: number;
}
/** A file in test/demo/photos and its description; see the README there for sources. */
interface PhotoSeed {
  file: string;
  es: string;
  gl: string;
}
interface UnitSeed {
  id: string;
  name: string;
  photos?: PhotoSeed[];
  minimum: number;
  maximum: number;
  step: number;
  weekly: Opening[];
}
interface FacilitySeed {
  id: string;
  name: string;
  photos?: PhotoSeed[];
  units: UnitSeed[];
}
interface MunicipalitySeed {
  id: string;
  name: string;
  rules: string;
  facilities: FacilitySeed[];
}

const hour = (value: number) => value * 60;
const weekdays = [1, 2, 3, 4, 5];
const weekend = [6, 7];
const everyDay = [1, 2, 3, 4, 5, 6, 7];

const padelHours: Opening[] = [
  { days: weekdays, startMinute: hour(8), endMinute: hour(23) },
  { days: weekend, startMinute: hour(9), endMinute: hour(21) },
];

const tennisPhoto: PhotoSeed = {
  file: "fontela-tenis.jpg",
  es: "Pistas de tenis de superficie dura rodeadas de árboles",
  gl: "Pistas de tenis de superficie dura rodeadas de árbores",
};
const padel: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d111",
  name: "Pista de pádel 1",
  photos: [
    {
      file: "fontela-padel-1.jpg",
      es: "Pista de pádel cubierta con paredes de cristal y malla metálica",
      gl: "Pista de pádel cuberta con paredes de vidro e malla metálica",
    },
  ],
  minimum: 60,
  maximum: 120,
  step: 30,
  weekly: padelHours,
};
const tennis: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d113",
  name: "Pista de tenis",
  photos: [tennisPhoto],
  minimum: 60,
  maximum: 120,
  step: 60,
  weekly: padelHours,
};
const football: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d114",
  name: "Campo de fútbol 7",
  photos: [
    {
      file: "fontela-futbol.jpg",
      es: "Campo de césped artificial bajo una cubierta translúcida",
      gl: "Campo de céspede artificial baixo unha cuberta translúcida",
    },
  ],
  minimum: 60,
  maximum: 120,
  step: 30,
  weekly: [
    { days: [1, 2, 3, 4], startMinute: hour(16), endMinute: hour(23) },
    { days: [5, 6], startMinute: hour(16), endMinute: hour(24) },
    { days: [6, 7], startMinute: 0, endMinute: hour(1) },
    { days: [7], startMinute: hour(10), endMinute: hour(20) },
  ],
};
const court: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d121",
  name: "Pista central",
  minimum: 60,
  maximum: 240,
  step: 60,
  weekly: [{ days: everyDay, startMinute: hour(9), endMinute: hour(22) }],
};
const hall: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d122",
  name: "Sala polivalente de actividades dirigidas y psicomotricidad",
  photos: [
    {
      file: "remedios-sala-1.jpg",
      es: "Sala amplia con tatami, espalderas y grandes ventanales",
      gl: "Sala ampla con tatami, espaldeiras e grandes ventás",
    },
    {
      file: "remedios-sala-2.jpg",
      es: "Fondo de la sala con espalderas y canasta",
      gl: "Fondo da sala con espaldeiras e canastra",
    },
  ],
  minimum: 30,
  maximum: 180,
  step: 30,
  weekly: [
    { days: weekdays, startMinute: hour(7), endMinute: hour(22) },
    { days: [6], startMinute: hour(9), endMinute: hour(14) },
  ],
};
const sportsCourt: UnitSeed = {
  id: "00000000-0000-4000-8000-00000000d211",
  name: "Pista polideportiva",
  minimum: 60,
  maximum: 120,
  step: 60,
  weekly: [{ days: everyDay, startMinute: hour(10), endMinute: hour(22) }],
};

export const valdeira: MunicipalitySeed = {
  id: "00000000-0000-4000-8000-00000000d100",
  name: "Valdeira",
  rules: `Normas de uso de las instalaciones deportivas municipales de Valdeira

1. Acceso
Presenta la confirmación de la reserva en el móvil o impresa si el personal la solicita. El acceso se permite cinco minutos antes del inicio.

2. Uso de la instalación
Utiliza calzado deportivo limpio y adecuado a la superficie. No está permitido comer en las pistas ni introducir envases de vidrio.

3. Final de la reserva
Deja la instalación libre a la hora de finalización para no afectar a la siguiente reserva. Recoge el material utilizado y comunica cualquier desperfecto al personal.

4. Menores de edad
Los menores de 14 años deben estar acompañados por una persona adulta responsable durante toda la reserva.

5. Incidencias
Si la instalación no está disponible por una causa municipal, el ayuntamiento contactará contigo para ofrecerte una alternativa.`,
  facilities: [
    {
      id: "00000000-0000-4000-8000-00000000d110",
      name: "Complejo Deportivo A Fontela",
      photos: [
        {
          file: "fontela-padel-exterior.jpg",
          es: "Vista general de las pistas de pádel exteriores",
          gl: "Vista xeral das pistas de pádel exteriores",
        },
        tennisPhoto,
      ],
      units: [
        padel,
        {
          ...padel,
          id: "00000000-0000-4000-8000-00000000d112",
          name: "Pista de pádel 2",
          photos: [
            {
              file: "fontela-padel-2.jpg",
              es: "Pista de pádel cubierta vista desde el fondo",
              gl: "Pista de pádel cuberta vista desde o fondo",
            },
          ],
        },
        tennis,
        football,
      ],
    },
    {
      id: "00000000-0000-4000-8000-00000000d120",
      name: "Pabellón Municipal Os Remedios",
      photos: [
        {
          file: "remedios-exterior.jpg",
          es: "Fachada del pabellón con su entrada principal",
          gl: "Fachada do pavillón coa súa entrada principal",
        },
      ],
      units: [court, hall],
    },
  ],
};

export const ribasanta: MunicipalitySeed = {
  id: "00000000-0000-4000-8000-00000000d200",
  name: "Ribasanta",
  rules: `Normas de uso das instalacións deportivas de Ribasanta

Respecta o horario reservado e deixa a pista libre ao remate.
Usa calzado deportivo axeitado. Non se permite comer nin fumar no recinto.
Comunica calquera desperfecto ao persoal da instalación.`,
  facilities: [
    {
      id: "00000000-0000-4000-8000-00000000d210",
      name: "Polideportivo do Porto",
      units: [sportsCourt],
    },
    {
      id: "00000000-0000-4000-8000-00000000d220",
      name: "Piscina municipal",
      units: [],
    },
  ],
};

async function account(
  app: FastifyInstance,
  auth: Pool,
  origin: string,
  address: string,
  email: string,
  name: string,
  mfa: boolean,
) {
  const client = browser(app, address, origin);
  const signup = await client.request("/api/auth/sign-up/email", {
    email,
    password,
    name,
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const accountId: string = signup.json().user.id;
  await auth.query('UPDATE auth."user" SET "emailVerified"=true WHERE id=$1', [
    accountId,
  ]);
  if (!mfa) return { accountId, email, secret: null };
  const signin = await client.request("/api/auth/sign-in/email", {
    email,
    password,
  });
  assert.equal(signin.statusCode, 200, signin.body);
  const enrollment = await client.request("/api/auth/two-factor/enable", {
    password,
  });
  assert.equal(enrollment.statusCode, 200, enrollment.body);
  const secret = new URL(enrollment.json().totpURI).searchParams.get("secret");
  assert.ok(secret);
  const verified = await client.request("/api/auth/two-factor/verify-totp", {
    code: totp(secret),
  });
  assert.equal(verified.statusCode, 200, verified.body);
  return { accountId, email, secret };
}

/** Stores the photos as the application would: re-encoded, in order, with the first as the cover. */
async function photos(
  migration: Pool,
  tenantId: string,
  facilityId: string,
  unitId: string | null,
  seeds: PhotoSeed[] = [],
) {
  for (const [index, seed] of seeds.entries()) {
    const photo = await processPhoto(
      await readFile(new URL(`photos/${seed.file}`, import.meta.url)),
    );
    await migration.query(
      "INSERT INTO domain.catalog_photo(tenant_id,id,facility_id,unit_id,position,alt_gl,alt_es,width,height,large,small) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        tenantId,
        randomUUID(),
        facilityId,
        unitId,
        index + 1,
        seed.gl,
        seed.es,
        photo.width,
        photo.height,
        photo.large,
        photo.small,
      ],
    );
  }
}

async function municipality(
  migration: Pool,
  seed: MunicipalitySeed,
  actorId: string,
) {
  await migration.query(
    "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,$2,$3,1440)",
    [seed.id, seed.name, timeZone],
  );
  // The catalog has been open for 60 days, recorded as the application would:
  // indicators derive offered time from calendar versions and publication events.
  const since = "now()-interval '60 days'";
  const event = (
    facility: string,
    unit: string | null,
    operation: string,
    calendar: number | null = null,
  ) =>
    migration.query(
      `INSERT INTO domain.catalog_event(tenant_id,id,actor_id,facility_id,unit_id,operation,reason,calendar_version,independence_confirmed,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,${since})`,
      [
        seed.id,
        randomUUID(),
        actorId,
        facility,
        unit,
        operation,
        operation.startsWith("PUBLISH") ? "Apertura del catálogo" : null,
        calendar,
        operation === "PUBLISH_UNIT" ? true : null,
      ],
    );
  for (const facility of seed.facilities) {
    await migration.query(
      `INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,$3,${since})`,
      [seed.id, facility.id, facility.name],
    );
    await event(facility.id, null, "CREATE_FACILITY");
    await event(facility.id, null, "PUBLISH_FACILITY");
    await photos(migration, seed.id, facility.id, null, facility.photos);
    for (const unit of facility.units) {
      await migration.query(
        "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,$4)",
        [seed.id, unit.id, facility.id, unit.name],
      );
      const weekly = unit.weekly.flatMap(({ days, startMinute, endMinute }) =>
        days.map((day) => ({ day, startMinute, endMinute })),
      );
      await migration.query(
        `INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason,created_at) VALUES($1,$2,1,$3,$4,$5,$6,'[]',$7,'Horario inicial',${since})`,
        [
          seed.id,
          unit.id,
          unit.minimum,
          unit.maximum,
          unit.step,
          JSON.stringify(weekly),
          actorId,
        ],
      );
      await migration.query(
        `INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id)
         VALUES($1,$2,1,$3,$4,'Normas iniciales',$5)`,
        [seed.id, unit.id, seed.rules, actorId, randomUUID()],
      );
      await migration.query(
        `UPDATE domain.reservable_unit SET calendar_version=1, usage_rules_version=1, published_at=${since} WHERE tenant_id=$1 AND id=$2`,
        [seed.id, unit.id],
      );
      await event(facility.id, unit.id, "CREATE_UNIT");
      await event(facility.id, unit.id, "PUBLISH_UNIT", 1);
      await photos(migration, seed.id, facility.id, unit.id, unit.photos);
    }
  }
}

async function administrator(
  migration: Pool,
  tenantId: string,
  accountId: string,
) {
  const invitation = randomUUID();
  await migration.query(
    "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [tenantId, accountId],
  );
  await migration.query(
    "INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,accepted_at) VALUES($1,$2,$3,$3,now()+interval '1 day',now())",
    [tenantId, invitation, accountId],
  );
  await migration.query(
    "INSERT INTO domain.municipal_administrator(tenant_id,account_id,invitation_id) VALUES($1,$2,$3)",
    [tenantId, accountId, invitation],
  );
}

function localDate(offsetDays: number, from = new Date()) {
  const date = new Date(from.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function nextWeekdayOffset(
  day: number,
  minimumOffset: number,
  from = new Date(),
) {
  for (let offset = minimumOffset; offset < minimumOffset + 7; offset++) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).format(new Date(from.getTime() + offset * 86400000));
    if (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1] === weekday)
      return offset;
  }
  throw new Error("Unreachable weekday");
}

function zoned(date: string, hours: number) {
  const guess = new Date(`${date}T${String(hours).padStart(2, "0")}:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(guess)
    .find((part) => part.type === "timeZoneName")
    ?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = offset
    ? (offset[1] === "-" ? -1 : 1) *
      (Number(offset[2]) * 60 + Number(offset[3]))
    : 0;
  return new Date(guess.getTime() - minutes * 60000).toISOString();
}

interface Slot {
  start: { utc: string; local: string };
  end: { utc: string; local: string };
}
let addressCounter = 10;
async function slots(
  app: FastifyInstance,
  tenantId: string,
  unitId: string,
  date: string,
  duration: number,
): Promise<Slot[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/public/municipalities/${tenantId}/units/${unitId}/availability?date=${date}&durationMinutes=${duration}`,
    remoteAddress: `198.51.100.${addressCounter++}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().slots;
}
async function slotAt(
  app: FastifyInstance,
  tenantId: string,
  unitId: string,
  date: string,
  duration: number,
  time: string,
) {
  const slot = (await slots(app, tenantId, unitId, date, duration)).find(
    (item) => item.start.local.slice(11, 16) === time,
  );
  assert.ok(slot, `No slot ${date} ${time} for ${unitId}`);
  return slot;
}

export async function seedDemo(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  origin: string,
) {
  const admin = await account(
    app,
    auth,
    origin,
    "198.51.100.1",
    "administracion@valdeira.demo.test",
    "Marta Couceiro",
    true,
  );
  const citizen = await account(
    app,
    auth,
    origin,
    "198.51.100.2",
    "lucia.pereira@demo.test",
    "Lucía Pereira Castro",
    false,
  );
  await municipality(migration, valdeira, admin.accountId);
  await municipality(migration, ribasanta, admin.accountId);
  await administrator(migration, valdeira.id, admin.accountId);

  const actor = {
    accountId: citizen.accountId,
    email: citizen.email,
    sessionId: "demo-seed",
    mfaVerifiedAt: null,
  };
  const reserve = async (
    tenantId: string,
    unitId: string,
    slot: Slot,
    options: { nonCancellable?: boolean; at?: Date } = {},
  ) =>
    (
      await createReservation(
        domain,
        actor,
        tenantId,
        randomUUID(),
        {
          unitId,
          startsAt: slot.start.utc,
          endsAt: slot.end.utc,
          acceptance: {
            usageRulesVersion: 1,
            bookingPolicyVersion: 1,
            nonCancellable: options.nonCancellable ?? false,
          },
        },
        randomUUID(),
        3600,
        options.at ? { now: () => options.at as Date } : undefined,
      )
    ).result;

  await reserve(
    valdeira.id,
    padel.id,
    await slotAt(app, valdeira.id, padel.id, localDate(4), 90, "19:00"),
  );
  const saturday = localDate(nextWeekdayOffset(6, 2));
  await reserve(
    valdeira.id,
    football.id,
    await slotAt(app, valdeira.id, football.id, saturday, 60, "23:30"),
  );
  const soon = [
    ...(await slots(app, valdeira.id, tennis.id, localDate(0), 60)),
    ...(await slots(app, valdeira.id, tennis.id, localDate(1), 60)),
  ].find(
    (slot) =>
      Date.parse(slot.start.utc) > Date.now() + 2 * 3600000 &&
      Date.parse(slot.start.utc) < Date.now() + 20 * 3600000,
  );
  if (soon)
    await reserve(valdeira.id, tennis.id, soon, { nonCancellable: true });
  const cancelled = await reserve(
    valdeira.id,
    hall.id,
    await slotAt(
      app,
      valdeira.id,
      hall.id,
      localDate(nextWeekdayOffset(1, 7)),
      90,
      "11:00",
    ),
  );
  await cancelReservation(
    domain,
    actor,
    valdeira.id,
    cancelled.id,
    randomUUID(),
    { expectedRevision: cancelled.revision },
    randomUUID(),
    3600,
  );
  const past = new Date(Date.now() - 12 * 86400000);
  const pastDate = localDate(2, past);
  await reserve(
    valdeira.id,
    court.id,
    {
      start: { utc: zoned(pastDate, 18), local: `${pastDate}T18:00` },
      end: { utc: zoned(pastDate, 20), local: `${pastDate}T20:00` },
    },
    { at: past },
  );
  await reserve(
    ribasanta.id,
    sportsCourt.id,
    await slotAt(app, ribasanta.id, sportsCourt.id, localDate(9), 60, "18:00"),
  );

  return {
    password,
    citizen: citizen.email,
    administrator: admin.email,
    administratorSecret: admin.secret,
    entry: valdeira.id,
  };
}
