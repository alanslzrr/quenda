import { Capture, expect, signIn, test } from "./capture";
import {
  choose,
  clientHeader,
  formWith,
  localDate,
  localTime,
  pickDate,
  pickDateTime,
  secondBrowser,
  snap,
  sql,
  units,
  valdeira,
} from "./steps";

// CU-04 — Mantener catálogo y calendario. La administradora de Valdeira da de
// alta una instalación con su unidad, completa la ficha, las normas y los
// horarios y la publica. Al terminar la retira del catálogo para que el resto
// de escenarios encuentren el catálogo sembrado sin cambios.
test("CU-04 mantener catálogo y calendario", async ({ page, browser }) => {
  test.setTimeout(240000);
  const cu = new Capture("CU-04");
  await signIn(page, "administrator");
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Gestión", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Instalaciones y unidades", level: 1 }),
  ).toBeVisible();

  // Paso 1: registrar la instalación por su nombre.
  const create = formWith(page, "Crear instalación");
  await create.getByLabel("Nombre").fill("Centro Deportivo O Souto");
  await snap(cu, page, "nueva-instalacion", {
    target: create.getByRole("button", { name: "Crear instalación" }),
  });
  await create.getByRole("button", { name: "Crear instalación" }).click();
  await page
    .getByRole("link", { name: "Centro Deportivo O Souto", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Centro Deportivo O Souto", level: 1 }),
  ).toBeVisible();
  const facilityUrl = page.url();
  await snap(cu, page, "instalacion-en-borrador", {
    target: page.getByRole("tab", { name: "Ficha", exact: true }),
  });

  // Paso 2: completar la ficha pública de la instalación.
  await page.getByRole("tab", { name: "Ficha", exact: true }).click();
  const profile = formWith(page, "Guardar ficha");
  await profile
    .getByLabel("Dirección", { exact: true })
    .fill("Rúa do Souto 12");
  await profile.getByLabel("Código postal").fill("15009");
  await profile.getByLabel("Latitud", { exact: true }).fill("43.3561");
  await profile.getByLabel("Longitud", { exact: true }).fill("-8.4069");
  await profile
    .getByLabel("Descripción en gallego")
    .fill("Pavillón cuberto cunha pista e vestiarios.");
  await profile
    .getByLabel("Descripción en castellano")
    .fill("Pabellón cubierto con una pista y vestuarios.");
  await profile
    .getByLabel("Accesibilidad en gallego")
    .fill("Acceso sen chanzos e aseo adaptado.");
  await profile
    .getByLabel("Accesibilidad en castellano")
    .fill("Acceso sin escalones y aseo adaptado.");
  await profile.getByLabel("Teléfono de contacto").fill("+34 981 000 120");
  await profile
    .getByLabel("Correo de contacto")
    .fill("deportes@valdeira.demo.test");
  await snap(cu, page, "ficha-instalacion", {
    tall: true,
    target: profile.getByRole("button", { name: "Guardar ficha" }),
  });
  await profile.getByRole("button", { name: "Guardar ficha" }).click();
  await expect(
    page.getByRole("main").getByText("Cambios guardados."),
  ).toBeVisible();

  // Paso 3: publicar la instalación con un motivo.
  await page
    .getByRole("button", { name: "Publicar instalación", exact: true })
    .click();
  const publish = page
    .getByRole("dialog")
    .locator("form")
    .filter({
      has: page.getByRole("button", { name: "Publicar instalación" }),
    });
  await publish.getByLabel("Motivo").fill("Apertura del nuevo pabellón");
  await snap(cu, page, "publicar-instalacion", {
    target: publish.getByRole("button", { name: "Publicar instalación" }),
  });
  await publish
    .getByRole("button", { name: "Publicar instalación", exact: true })
    .click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();

  // Paso 4: crear la unidad reservable.
  await page.getByRole("tab", { name: "Datos", exact: true }).click();
  await page.getByRole("link", { name: "Crear unidad", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Nueva unidad reservable" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Nombre", exact: true })
    .fill("Pista do Souto");
  await snap(cu, page, "nueva-unidad", {
    target: page.getByRole("button", { name: /Crear unidad/ }),
  });
  await page.getByRole("button", { name: /Crear unidad/ }).click();
  await page.getByRole("link", { name: "Volver al catálogo" }).click();
  await page.getByRole("link", { name: "Pista do Souto", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Pista do Souto", level: 1 }),
  ).toBeVisible();

  // Paso 5: ficha de la unidad: tipo, ubicación y aforo.
  await page.getByRole("tab", { name: "Ficha", exact: true }).click();
  const unitProfile = formWith(page, "Guardar ficha");
  await choose(page, "Tipo de espacio", "Pista polideportiva", unitProfile);
  await choose(page, "Ubicación", "Cubierto", unitProfile);
  await unitProfile.getByLabel("Aforo máximo (personas)").fill("12");
  await unitProfile
    .getByLabel("Descripción en gallego")
    .fill("Pista de parqué para baloncesto, voleibol e fútbol sala.");
  await unitProfile
    .getByLabel("Descripción en castellano")
    .fill("Pista de parqué para baloncesto, voleibol y fútbol sala.");
  await snap(cu, page, "ficha-unidad", {
    tall: true,
    target: unitProfile.getByRole("button", { name: "Guardar ficha" }),
  });
  await unitProfile.getByRole("button", { name: "Guardar ficha" }).click();
  await expect(
    page.getByRole("main").getByText("Cambios guardados."),
  ).toBeVisible();

  // Paso 6: normas de uso.
  await page.getByRole("tab", { name: "Normas", exact: true }).click();
  const rules = formWith(page, "Guardar normas");
  await rules
    .getByLabel("Texto de las normas")
    .fill(
      "Uso deportivo con calzado de pista. Respeta el horario reservado y deja la pista libre al terminar.",
    );
  await rules.getByLabel("Motivo").fill("Normas iniciales");
  await snap(cu, page, "normas", {
    target: rules.getByRole("button", { name: "Guardar normas" }),
  });
  await rules.getByRole("button", { name: "Guardar normas" }).click();
  await expect(rules.getByText("Cambios guardados")).toBeVisible();

  // Paso 7: horarios, duración, antelación y una excepción.
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  const calendar = formWith(page, "Guardar horarios");
  await calendar.getByLabel("Duración mínima (minutos)").fill("60");
  await calendar.getByLabel("Duración máxima (minutos)").fill("120");
  await calendar.getByLabel("Paso de horarios (minutos)").fill("60");
  await calendar.getByLabel("Antelación de la unidad (días)").fill("21");
  for (const [day, start, end] of [
    ["Lunes", "16:00", "22:00"],
    ["Miércoles", "16:00", "22:00"],
    ["Sábado", "10:00", "14:00"],
  ] as const) {
    await calendar
      .getByRole("button", { name: "Añadir franja semanal" })
      .click();
    const slot = calendar
      .getByRole("group", { name: /^Franja semanal \d+$/ })
      .last();
    await choose(page, "Día", day, slot);
    await slot.getByLabel("Inicio (HH:mm)").fill(start);
    await slot.getByLabel("Fin (HH:mm)").fill(end);
  }
  await calendar.getByRole("button", { name: "Añadir excepción" }).click();
  const exception = calendar
    .getByRole("group", { name: /^Excepción \d+$/ })
    .last();
  await pickDate(
    page,
    "Fecha",
    `${Number(localDate().slice(0, 4))}-12-25`,
    exception,
  );
  await choose(page, "Apertura", "Cerrada todo el día", exception);
  await calendar.getByLabel("Motivo").fill("Horario de apertura");
  await snap(cu, page, "horarios", {
    tall: true,
    target: calendar.getByRole("button", { name: "Guardar horarios" }),
  });
  await calendar.getByRole("button", { name: "Guardar horarios" }).click();
  await expect(calendar.getByText("Cambios guardados")).toBeVisible();

  // Paso 8: publicar la unidad, físicamente independiente.
  await page.getByRole("button", { name: /Publicar unidad/ }).click();
  const unitPublish = page
    .getByRole("dialog")
    .locator("form")
    .filter({ has: page.getByRole("button", { name: /Publicar unidad/ }) });
  await unitPublish.getByLabel("Motivo").fill("Apertura de la pista");
  await unitPublish.getByRole("checkbox").check();
  await snap(cu, page, "publicar-unidad", {
    target: unitPublish.getByRole("button", { name: /Publicar unidad/ }),
  });
  await unitPublish.getByRole("button", { name: /Publicar unidad/ }).click();
  await expect(page.getByText("Publicada", { exact: true })).toBeVisible();
  await snap(cu, page, "unidad-publicada", {
    target: page.getByText("Publicada", { exact: true }),
  });

  // Resultado: la ciudadanía la encuentra en el catálogo público.
  const unitUrl = page.url();
  await page.goto(`/municipios/${valdeira}`);
  const card = page
    .getByRole("link", { name: /Centro Deportivo O Souto/ })
    .first();
  await expect(card).toBeVisible();
  await snap(cu, page, "catalogo-publico", { target: card, fullPage: true });

  // The alternatives open many pages: a new client address keeps the
  // per-address limit of the public catalogue (and the municipal logo) away.
  await page.context().setExtraHTTPHeaders(clientHeader());

  // Alternativa: publicar una unidad sin normas mantiene el borrador.
  await page.goto(facilityUrl);
  await page.getByRole("link", { name: "Crear unidad", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Nueva unidad reservable" }),
  ).toBeVisible();
  const unitName = page.getByRole("textbox", { name: "Nombre", exact: true });
  await expect(async () => {
    await unitName.fill("Sala do Souto");
    await expect(unitName).toHaveValue("Sala do Souto", { timeout: 1000 });
  }).toPass();
  const unitCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/units$/.test(response.url()),
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: /Crear unidad/ }).click();
  expect((await unitCreated).ok()).toBe(true);
  await page.getByRole("link", { name: "Volver al catálogo" }).click();
  await page.getByRole("link", { name: "Sala do Souto", exact: true }).click();
  await page.getByRole("button", { name: /Publicar unidad/ }).click();
  const missing = page.getByText(
    "Añade las normas de uso para publicar esta unidad",
  );
  await expect(missing).toBeVisible();
  await snap(cu, page, "publicar-sin-normas", { target: missing });
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();

  // Alternativa: otra persona guardó la ficha antes (versión obsoleta).
  await page.goto(facilityUrl);
  await page.getByRole("tab", { name: "Ficha", exact: true }).click();
  // Alternativa: otra persona guardó la ficha antes (versión obsoleta).
  const other = await secondBrowser(browser, page, true);
  try {
    const colleague = await other.newPage();
    await colleague.goto(facilityUrl);
    await colleague.getByRole("tab", { name: "Ficha", exact: true }).click();
    const theirs = formWith(colleague, "Guardar ficha");
    await theirs.getByLabel("Teléfono de contacto").fill("+34 981 000 121");
    await theirs.getByRole("button", { name: "Guardar ficha" }).click();
    await expect(
      colleague.getByRole("main").getByText("Cambios guardados."),
    ).toBeVisible();
  } finally {
    await other.close();
  }
  await profile
    .getByLabel("Correo de contacto")
    .fill("instalacions@valdeira.demo.test");
  await profile.getByRole("button", { name: "Guardar ficha" }).click();
  const stale = page.getByRole("main").getByRole("alert");
  await expect(stale).toBeVisible();
  await snap(cu, page, "ficha-version-obsoleta", { tall: true, target: stale });
  await page.reload();
  await page.getByRole("tab", { name: "Ficha", exact: true }).click();
  await expect(
    formWith(page, "Guardar ficha").getByLabel("Teléfono de contacto"),
  ).toHaveValue("+34 981 000 121");

  // Alternativa: un bloqueo válido ocupa la agenda e impide reservar.
  const blockDate = localDate(9);
  await page.goto(`/administracion/${valdeira}/agenda`);
  await pickDate(page, "Fecha de la agenda", blockDate);
  const block = formWith(page, "Crear bloqueo");
  await choose(page, "Unidad a bloquear", "Pista do Souto");
  await pickDateTime(page, "Inicio del bloqueo", blockDate, "10:00", block);
  await pickDateTime(page, "Fin del bloqueo", blockDate, "12:00", block);
  await block.getByLabel("Motivo").fill("Revisión del parqué");
  await block.getByRole("checkbox").check();
  await snap(cu, page, "bloqueo", {
    target: block.getByRole("button", { name: "Crear bloqueo" }),
  });
  await block.getByRole("button", { name: "Crear bloqueo" }).click();
  const created = page.getByText("Revisión del parqué", { exact: true });
  await expect(created).toBeVisible();
  await snap(cu, page, "bloqueo-creado", {
    target: created.locator(
      "xpath=ancestor::*[.//button[normalize-space()='Liberar bloqueo']][1]",
    ),
  });

  // Alternativa: un bloqueo que coincide con una reserva confirmada se rechaza.
  const [taken] = await sql<{ starts_at: Date; ends_at: Date }>(
    "migration",
    `SELECT starts_at, ends_at FROM domain.reservation
      WHERE tenant_id=$1 AND unit_id=$2 AND status='CONFIRMADA'
        AND starts_at > now() + interval '3 days'
      ORDER BY starts_at LIMIT 1`,
    [valdeira, units.padel1],
  );
  if (!taken) throw new Error("No confirmed reservation to collide with");
  const takenDate = localDate(0, taken.starts_at.getTime());
  await pickDate(page, "Fecha de la agenda", takenDate);
  const collide = formWith(page, "Crear bloqueo");
  await choose(page, "Unidad a bloquear", "Pista de pádel 1");
  await pickDateTime(
    page,
    "Inicio del bloqueo",
    takenDate,
    localTime(taken.starts_at),
    collide,
  );
  await pickDateTime(
    page,
    "Fin del bloqueo",
    takenDate,
    localTime(taken.ends_at),
    collide,
  );
  await collide.getByLabel("Motivo").fill("Limpieza de cristales");
  await collide.getByRole("checkbox").check();
  await collide.getByRole("button", { name: "Crear bloqueo" }).click();
  const refused = collide.getByRole("alert");
  await expect(refused).toBeVisible();
  await snap(cu, page, "bloqueo-con-reservas", {
    target: refused,
    fullPage: true,
  });

  // Alternativa: cerrar todas las franjas de una unidad con reservas confirmadas.
  await page.goto(`/administracion/${valdeira}/unidades/${units.padel1}`);
  await page.getByRole("tab", { name: "Horarios", exact: true }).click();
  const busy = formWith(page, "Guardar horarios");
  const remove = busy.getByRole("button", { name: /^Quitar franja/ });
  await expect(remove.first()).toBeVisible();
  for (const group of await busy
    .getByRole("group", { name: /^Franja semanal/ })
    .all())
    await expect(group).toBeVisible();
  while (
    await busy
      .getByRole("group", { name: /^Franja semanal/ })
      .getByRole("button", { name: /^Quitar franja/ })
      .count()
  )
    await busy
      .getByRole("group", { name: /^Franja semanal/ })
      .getByRole("button", { name: /^Quitar franja/ })
      .first()
      .click();
  await busy.getByLabel("Motivo").fill("Cierre de la pista");
  await busy.getByRole("button", { name: "Guardar horarios" }).click();
  const incompatible = busy.getByRole("alert").first();
  await expect(incompatible).toBeVisible();
  await snap(cu, page, "horario-con-reservas", { target: incompatible });
  await page
    .getByRole("button", { name: "Descartar borrador y recargar horarios" })
    .click();

  // Alternativa: retirar la unidad la oculta sin borrar reservas ni historial.
  await page.goto(unitUrl);
  await page.getByRole("button", { name: "Retirar del catálogo" }).click();
  const withdraw = formWith(page, "Retirar");
  await withdraw.getByLabel("Motivo").fill("Fin de la temporada");
  await withdraw.getByRole("checkbox").check();
  await snap(cu, page, "retirar-unidad", {
    target: withdraw.getByRole("button", { name: "Retirar", exact: true }),
  });
  await withdraw.getByRole("button", { name: "Retirar", exact: true }).click();
  const withdrawn = page.getByText("Retirada del catálogo público");
  await expect(withdrawn).toBeVisible();
  await snap(cu, page, "unidad-retirada", { target: withdrawn });

  // Limpieza: la instalación también deja de publicarse.
  await page.goto(facilityUrl);
  await page.getByRole("button", { name: "Retirar del catálogo" }).click();
  const facilityWithdraw = formWith(page, "Retirar");
  await facilityWithdraw.getByLabel("Motivo").fill("Fin de la temporada");
  await facilityWithdraw.getByRole("checkbox").check();
  await facilityWithdraw
    .getByRole("button", { name: "Retirar", exact: true })
    .click();
  await expect(page.getByText("Retirada del catálogo público")).toBeVisible();
});
