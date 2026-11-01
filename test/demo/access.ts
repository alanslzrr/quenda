import path from "node:path";
import { currentDemoCode, readDemoAccess } from "./access-state.ts";

try {
  const access = await readDemoAccess(path.resolve(".local/demo"));
  const result = await currentDemoCode(access);
  console.log(
    `Administración: ${access.administrator}\nWeb: ${access.webOrigin}/acceso\nCódigo TOTP: ${result.code} (vigente durante ${result.remainingSeconds} s)\nArranque verificado: ${access.startedAt}`,
  );
} catch (error) {
  // Do not print parsing errors, credentials, or arbitrary response content.
  const known =
    error instanceof Error &&
    [
      "Invalid demo access metadata",
      "Demo access directory must be owned by this user with mode 0700",
      "Demo access file must be owned by this user with mode 0600",
      "The demo cannot confirm its current run; do not use a code from an old log",
      "Demo access metadata belongs to a different launch; no code was generated",
    ].includes(error.message);
  console.error(
    known
      ? error.message
      : "No se pudo verificar el acceso de la demo. Comprueba que esté arrancada con la versión actual y exista .local/demo/access.json; no reutilices secretos de registros anteriores.",
  );
  process.exitCode = 1;
}
