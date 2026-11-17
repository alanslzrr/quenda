import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Capture, expect, signIn, test } from "./capture";
import {
  choose,
  freshAccount,
  grantManager,
  localDate,
  pickDate,
  secondBrowser,
  section,
  signInAs,
  snap,
  units,
  valdeira,
} from "./steps";

const run = promisify(execFile);
const region = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("region", { name, exact: true });

// CU-05 — Consultar el uso de los espacios o exportar datos municipales.
// El gestor de reservas de Valdeira consulta los indicadores; la exportación
// la hace la administradora, que tiene el permiso de exportar datos.
test("CU-05 consultar el uso de los espacios y exportar reservas", async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const cu = new Capture("CU-05");
  await signIn(page, "manager");
  await page
    .getByRole("navigation", { name: "Navegación principal" })
    .getByRole("link", { name: "Gestión", exact: true })
    .click();

  // Paso 1: abrir «Uso de los espacios» con el periodo inicial.
  await section(page, "Uso de los espacios");
  await expect(
    region(page, "Lo más destacado").getByRole("listitem"),
  ).not.toHaveCount(0);
  const period = page.getByRole("button", { name: /^Periodo:/ });
  await snap(cu, page, "uso-inicial", { target: period });

  // Paso 2: cambiar el periodo con un atajo.
  await period.click();
  const shortcuts = page.getByRole("dialog", { name: "Periodo" });
  const lastMonth = shortcuts.getByRole("button", { name: "Mes pasado" });
  await expect(lastMonth).toBeVisible();
  await snap(cu, page, "periodo-atajos", { target: lastMonth });
  await lastMonth.click();
  const apply = shortcuts.getByRole("button", { name: "Aplicar", exact: true });
  await snap(cu, page, "periodo-aplicar", { target: apply });
  await apply.click();
  await expect(shortcuts).toHaveCount(0);
  const shown = page
    .getByRole("status")
    .filter({ hasText: /^del 1 al 3\d de / });
  await expect(shown).toBeVisible();
  await expect(region(page, "Resumen").getByRole("article")).toHaveCount(5);
  await snap(cu, page, "periodo-mes-pasado", { target: shown });

  // Paso 3: lo más destacado, resumen, evolución, espacios, demanda y cumplimiento.
  for (const [name, slug] of [
    ["Resumen", "resumen"],
    ["Evolución de la ocupación", "evolucion"],
    ["Espacios", "espacios"],
    ["Cuándo hay más demanda", "demanda"],
    ["¿Se cumplen las reservas?", "cumplimiento"],
  ] as const) {
    const part = region(page, name);
    await expect(part).toBeVisible();
    await snap(cu, page, slug, { tall: true, clip: part });
  }

  // Paso 2 (continuación): elegir un espacio por su nombre.
  await page.getByRole("combobox", { name: "Espacio", exact: true }).click();
  const option = page.getByRole("option", { name: /^Pista de tenis/ });
  await expect(option).toBeVisible();
  await snap(cu, page, "elegir-espacio", { target: option });
  await option.click();
  await expect(page).toHaveURL(/espacio=/);
  await expect(
    region(page, "Espacios").getByRole("button", { name: /^Pista de pádel 1/ }),
  ).toHaveCount(0);
  await snap(cu, page, "un-espacio", {
    target: page
      .getByRole("combobox", { name: "Espacio", exact: true })
      .locator("xpath=ancestor::div[.//button][1]"),
  });

  // Alternativa: sin permiso de exportación no aparece «Exportar reservas».
  const navigation = page.getByRole("navigation", {
    name: "Gestión municipal",
  });
  await expect(
    navigation.getByRole("link", { name: "Exportar reservas" }),
  ).toHaveCount(0);
  await snap(cu, page, "gestor-sin-exportar", { target: navigation });
  await page.goto(`/administracion/${valdeira}/exportaciones`);
  const denied = page.getByText("No tienes permiso para esta operación.");
  await expect(denied).toBeVisible();
  await snap(cu, page, "exportar-sin-permiso", { target: denied });

  // Alternativa: con permiso sobre algunos espacios no se ve el total municipal.
  const admin = await secondBrowser(browser, page);
  const marta = await admin.newPage();
  try {
    await signIn(marta, "administrator");
    const iria = await freshAccount(
      "iria.castro@valdeira.demo.test",
      "Iria Castro Neira",
    );
    await grantManager(marta, valdeira, iria, [
      { operation: "REPORT_READ", unitId: units.padel1 },
      {
        operation: "REPORT_READ",
        unitId: "00000000-0000-4000-8000-00000000d112",
      },
    ]);
    const partial = await secondBrowser(browser, page);
    try {
      const scoped = await partial.newPage();
      await signInAs(scoped, iria);
      await scoped.goto(`/administracion/${valdeira}/uso-de-los-espacios`);
      await scoped
        .getByRole("combobox", { name: "Espacio", exact: true })
        .click();
      const choices = scoped.getByRole("listbox");
      await expect(choices.getByRole("option")).toHaveCount(2);
      await snap(cu, scoped, "gestor-algunos-espacios", {
        target: scoped
          .getByRole("combobox", { name: "Espacio", exact: true })
          .locator("xpath=ancestor::div[.//button][1]"),
      });
      await scoped.keyboard.press("Escape");
    } finally {
      await partial.close();
    }

    // Paso 4: exportar las reservas una a una (hoja de cálculo).
    await marta
      .getByRole("navigation", { name: "Navegación principal" })
      .getByRole("link", { name: "Gestión", exact: true })
      .click();
    await section(marta, "Exportar reservas");
    const from = localDate(-14);
    const to = localDate(-7);
    await pickDate(marta, "Desde (incluido)", from);
    await pickDate(marta, "Hasta (excluido)", to);
    await choose(marta, "Formato", "Hoja de cálculo");
    await marta
      .getByRole("checkbox", {
        name: "Confirmo la descarga de datos del ámbito autorizado",
      })
      .check();
    const download = marta.getByRole("button", { name: /^Descargar/ });
    await snap(cu, marta, "exportar-formulario", {
      tall: true,
      target: download,
    });
    const downloading = marta.waitForEvent("download");
    await download.click();
    const file = await downloading;
    const folder = path.resolve("../.local/capture/descargas");
    await mkdir(folder, { recursive: true });
    const name = file.suggestedFilename();
    await file.saveAs(path.join(folder, name));
    const notice = marta
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: /\S/ });
    await expect(notice.first()).toBeVisible();
    await snap(cu, marta, "exportar-descargado", {
      tall: true,
      target: notice.first(),
    });
    const head = await run("head", ["-n", "4", name], { cwd: folder });
    await cu.terminal(
      marta,
      "exportar-archivo",
      `head -n 4 ${name}`,
      head.stdout,
    );

    // Alternativa: más de 366 días se rechaza sin generar archivo.
    await pickDate(
      marta,
      "Desde (incluido)",
      `${Number(localDate().slice(0, 4)) - 1}-01-01`,
    );
    await pickDate(marta, "Hasta (excluido)", localDate());
    await marta.getByRole("button", { name: /^Descargar/ }).click();
    const tooLong = marta.getByRole("main").getByRole("alert").first();
    await expect(tooLong).toBeVisible();
    await snap(cu, marta, "exportar-periodo-largo", {
      tall: true,
      target: tooLong,
    });
  } finally {
    await admin.close();
  }
});
