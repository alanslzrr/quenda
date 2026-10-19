import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MailTransport } from "../shared/mail.ts";

// Local development transport. Messages contain verification/reset links and
// are private files, never response bodies, public assets or application logs.
export function localMail(directory: string): MailTransport {
  return {
    async send(message) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `${randomUUID()}.json`),
        JSON.stringify(message),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    },
  };
}
