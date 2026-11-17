import { readFile } from "node:fs/promises";
import { access, account, Capture, expect, roles, test } from "./capture";
import { shot, signInWith } from "./citizen";

// CU-19 — Obtener una copia de datos personales. La vecina descarga su copia
// y se muestran dos fragmentos del archivo recibido.
const cu = new Capture("CU-19");

type Personal = {
  format: string;
  version: number;
  generatedAt: string;
  subjectAccountId: string;
  scope: unknown;
  completeness: unknown;
  records: { category: string }[];
};

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
  const name = file.suggestedFilename();
  expect(name).toBe("quenda-personal-data.json");
  const saved = test.info().outputPath(name);
  await file.saveAs(saved);
  const data = JSON.parse(await readFile(saved, "utf8")) as Personal;

  // Paso 2: el principio del archivo declara su alcance y sus exclusiones.
  const { records, ...header } = data;
  const opening = JSON.stringify(header, null, 2).replace(/\n}$/, "");
  await cu.file(
    page,
    "alcance-de-la-copia",
    name,
    `${opening},\n  "records": [ … ${records.length} registros … ]\n}`,
  );

  // Paso 3: cada registro indica su categoría; un ejemplo resumido de cada
  // una, con sus primeros datos legibles.
  const categories = [...new Set(records.map((record) => record.category))];
  const examples = categories.map((category) => {
    const record = records.find((item) => item.category === category) as {
      category: string;
      type: string;
      data: Record<string, unknown>;
    };
    const fields = Object.entries(record.data)
      .filter(
        ([, value]) =>
          ["string", "number", "boolean"].includes(typeof value) &&
          String(value).length <= 40,
      )
      .slice(0, 3)
      .map(([key, value]) => `        "${key}": ${JSON.stringify(value)},`);
    return [
      "    {",
      `      "category": "${category}",`,
      `      "type": "${record.type}",`,
      '      "data": {',
      ...fields,
      "        …",
      "      }",
      "    },",
      "    …",
    ].join("\n");
  });
  await cu.file(
    page,
    "registros-por-categoria",
    name,
    `{\n  …\n  "records": [\n${examples.join("\n")}\n  ]\n}`,
  );
});
