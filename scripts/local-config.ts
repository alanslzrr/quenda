import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";

const names = [".env.local", ".env.migration.local", ".env.bootstrap.local"];
for (const name of names) {
  let exists = false;
  try {
    await access(name);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) throw new Error(`Refusing to overwrite ${name}`);
}
const secret = () => randomBytes(32).toString("hex");
const passwords = {
  bootstrap: secret(),
  migration: secret(),
  domain: secret(),
  auth: secret(),
};
const url = (role: string, password: string) =>
  `postgresql://${role}:${password}@127.0.0.1:55432/quenda`;
const files = {
  ".env.local": `HOST=127.0.0.1\nPORT=3000\nLOG_LEVEL=info\nDATABASE_POOL_MAX=5\nAUTH_ORIGIN=http://localhost:3000\nAUTH_SECRET=${secret()}\nLOCAL_MAIL_DIR=.local/mail\nDOMAIN_DATABASE_URL=${url("quenda_domain", passwords.domain)}\nAUTH_DATABASE_URL=${url("quenda_auth", passwords.auth)}\n`,
  ".env.migration.local": `MIGRATION_DATABASE_URL=${url("quenda_migrator", passwords.migration)}\n`,
  ".env.bootstrap.local": `BOOTSTRAP_DATABASE_PASSWORD=${passwords.bootstrap}\nBOOTSTRAP_DATABASE_URL=${url("quenda_bootstrap", passwords.bootstrap)}\nMIGRATION_DATABASE_PASSWORD=${passwords.migration}\nDOMAIN_DATABASE_PASSWORD=${passwords.domain}\nAUTH_DATABASE_PASSWORD=${passwords.auth}\n`,
};
for (const [name, contents] of Object.entries(files)) {
  await writeFile(name, contents, { flag: "wx", mode: 0o600 });
}
process.stdout.write(
  "Local configuration created; credentials are not printed\n",
);
