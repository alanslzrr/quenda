import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// Machine credentials use printable ASCII so PostgreSQL and clients derive the
// same bytes without depending on different Unicode/SASLprep implementations.
export function scramVerifier(password: string): string {
  if (!/^[\x20-\x7e]{24,}$/.test(password))
    throw new Error(
      "Database passwords must contain at least 24 printable ASCII characters",
    );
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
}
