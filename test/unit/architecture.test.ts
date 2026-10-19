import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { moduleDefinition as catalog } from "../../src/modules/catalog/index.ts";
import { moduleDefinition as collaboration } from "../../src/modules/collaboration/index.ts";
import { moduleDefinition as communications } from "../../src/modules/communications/index.ts";
import { moduleDefinition as identity } from "../../src/modules/identity/index.ts";
import { moduleDefinition as reservations } from "../../src/modules/reservations/index.ts";

const modules = [
  identity,
  catalog,
  reservations,
  collaboration,
  communications,
];

test("module dependencies are acyclic and source imports respect public boundaries", async () => {
  const graph = new Map<string, readonly string[]>(
    modules.map((m) => [m.name, m.dependencies]),
  );
  function visit(name: string, ancestors: string[] = []) {
    assert.ok(!ancestors.includes(name), `Circular module dependency: ${name}`);
    const dependencies = graph.get(name);
    assert.ok(dependencies, `Unknown module ${name}`);
    for (const dependency of dependencies)
      visit(dependency, [...ancestors, name]);
  }
  for (const name of graph.keys()) visit(name);
  const root = path.resolve("src");
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
    );
    const owner =
      file.split(path.sep)[0] === "modules"
        ? file.split(path.sep)[1]
        : undefined;
    const inspect = (node: ts.Node) => {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const arg = node.arguments[0];
        assert.ok(
          arg && ts.isStringLiteral(arg),
          "Dynamic imports must have a literal target",
        );
        specifier = arg.text;
      }
      if (specifier?.startsWith(".")) {
        const destination = path.relative(
          root,
          path.resolve(root, path.dirname(file), specifier),
        );
        const parts = destination.split(path.sep);
        if (parts[0] === "modules" && parts[1] !== owner) {
          const target = parts[1];
          assert.ok(target);
          assert.equal(
            parts.slice(2).join("/"),
            "index.ts",
            `Private module import: ${file}`,
          );
          if (owner)
            assert.ok(
              graph.get(owner)?.includes(target),
              `Forbidden dependency: ${owner} -> ${target}`,
            );
          else
            assert.ok(
              !["shared", "database", "http"].includes(
                file.split(path.sep)[0] ?? "",
              ),
              `Infrastructure imports a business module: ${file}`,
            );
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
});
