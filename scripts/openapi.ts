import { buildApp } from "../src/app.ts";

const app = await buildApp({
  logLevel: "silent",
  database: {
    check: async () => {
      throw new Error("No database in schema generation");
    },
    close: async () => {},
  },
});
try {
  await app.ready();
  process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
} finally {
  await app.close();
}
