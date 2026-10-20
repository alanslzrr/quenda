import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type DependencyNode = {
  path?: string;
  dependencies?: Record<string, DependencyNode>;
  devDependencies?: Record<string, DependencyNode>;
  optionalDependencies?: Record<string, DependencyNode>;
};
export function dependencyPaths(roots: DependencyNode[]) {
  const paths = new Set<string>();
  const visit = (node: DependencyNode) => {
    if (node.path) paths.add(node.path);
    for (const group of [
      node.dependencies,
      node.devDependencies,
      node.optionalDependencies,
    ])
      for (const child of Object.values(group ?? {})) visit(child);
  };
  for (const root of roots) {
    for (const group of [
      root.dependencies,
      root.devDependencies,
      root.optionalDependencies,
    ])
      for (const child of Object.values(group ?? {})) visit(child);
  }
  return paths;
}

export async function licenseInventory(all: Set<string>, runtime: Set<string>) {
  const packages = [];
  const unavailable: string[] = [];
  for (const root of [...all].sort()) {
    let source: string;
    try {
      source = await readFile(path.join(root, "package.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      unavailable.push(
        root.slice(root.lastIndexOf(`${path.sep}node_modules${path.sep}`) + 14),
      );
      continue;
    }
    const manifest = JSON.parse(source);
    const evidence = [];
    for (const filename of (await readdir(root)).sort()) {
      if (
        !/^(licen[sc]e|copying|notice)([.-]|$)/i.test(filename) &&
        !/^readme([.-]|$)/i.test(filename)
      )
        continue;
      const content = await readFile(path.join(root, filename), "utf8");
      const readme = /^readme/i.test(filename);
      // A heading, SPDX identifier or hyperlink alone is not the permission text.
      if (
        readme &&
        !(
          content.includes("Permission is hereby granted") &&
          /copyright/i.test(content)
        )
      )
        continue;
      evidence.push({
        file: filename,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    packages.push({
      name: manifest.name as string,
      version: manifest.version as string,
      scope: runtime.has(root) ? "runtime" : "development",
      declaredLicense: manifest.license ?? null,
      evidence,
      reviewRequired: !manifest.license || evidence.length === 0,
    });
  }
  packages.sort((a, b) =>
    `${a.name}@${a.version}:${a.scope}`.localeCompare(
      `${b.name}@${b.version}:${b.scope}`,
      "en",
    ),
  );
  return {
    formatVersion: 1,
    scope:
      "installed dependency graph; excludes operating system and uninstalled platform packages",
    status:
      unavailable.length > 0 || packages.some((p) => p.reviewRequired)
        ? "REVIEW_REQUIRED"
        : "EVIDENCE_COLLECTED",
    unavailable,
    packages,
  };
}
