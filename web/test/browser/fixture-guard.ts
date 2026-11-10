import type { FullConfig } from "@playwright/test";

// The test server seeds one fixture set for the desktop project and one for any
// other project. Two non-desktop projects in one run would share accounts and
// resources, so each of them needs its own invocation and database.
export default function fixtureGuard(config: FullConfig) {
  const shared = config.projects.filter(
    (project) => project.name !== "desktop",
  );
  if (shared.length > 1)
    throw new Error(
      `Projects ${shared.map((project) => project.name).join(", ")} would share browser fixtures; run them in separate invocations`,
    );
}
