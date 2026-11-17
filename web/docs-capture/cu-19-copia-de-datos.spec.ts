import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { access, account, Capture, expect, roles, test } from "./capture";
import { shot, signInWith } from "./citizen";

// CU-19 — Obtener una copia de datos personales. La vecina descarga su copia
// y se muestra su contenido con jq.
const cu = new Capture("CU-19");
const run = promisify(execFile);

test("CU-19 obtener una copia de datos personales", async ({ page }) => {
  const { email } = await account(roles.citizen);
  await signInWith(page, email, (await access()).password);

  // Paso 1: solicitar la descarga desde «Privacidad y baja».
  await page.goto("/perfil/privacidad");
  const button = page.getByRole("button", {
    name: "Descargar datos personales",
  });
  await expect(button).toBeVisible();
  await shot(cu, page, "descargar-datos", { target: button });
  const download = page.waitForEvent("download");
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("quenda-personal-data.json");
  const saved = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(saved);

  // Paso 2: el archivo declara su alcance parcial y lo que excluye.
  const show = async (slug: string, filter: string) => {
    const { stdout } = await run("jq", [filter, path.basename(saved)], {
      cwd: path.dirname(saved),
    });
    await cu.terminal(
      page,
      slug,
      `jq '${filter}' ${path.basename(saved)}`,
      stdout,
    );
  };
  await show("alcance-de-la-copia", "{format, scope, completeness}");
  await show(
    "registros-por-categoria",
    "[.records[].category] | group_by(.) | map({(.[0]): length}) | add",
  );
});
