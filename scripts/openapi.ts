import { Pool } from "pg";
import { buildApp } from "../src/app.ts";

// Register the same routes without executing handlers or initializing an auth
// adapter. Contract generation must not need credentials or a running database.
const unavailable = async (): Promise<never> => {
  throw new Error(
    "Runtime operations are unavailable during schema generation",
  );
};
const domain = new Pool();
const app = await buildApp({
  logLevel: "silent",
  database: { check: unavailable, close: () => domain.end() },
  domain,
  identity: {
    config: {
      origin: "https://schema.invalid",
      secret: "not-used-by-contract-generation",
    },
    authentication: {
      handler: unavailable,
      schema: unavailable,
      verifyDeactivation: unavailable,
      requestReactivation: unavailable,
      confirmReactivation: unavailable,
      requestEmailChange: unavailable,
      approveEmailChange: unavailable,
      confirmEmailChange: unavailable,
      authenticate: unavailable,
    },
  },
});
try {
  await app.ready();
  process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
} finally {
  await app.close();
}
