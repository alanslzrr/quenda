import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import type { MailTransport } from "../shared/mail.ts";
import { type MailConfiguration, validMailbox } from "./config.ts";
import { localMail } from "./local.ts";

export function createMailTransport(config: MailConfiguration): MailTransport {
  if (config.kind === "local") return localMail(config.directory);
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    opportunisticTLS: false,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: config.servername,
      ...(config.caFile ? { ca: readFileSync(config.caFile) } : {}),
    },
    ...(config.user
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    dnsTimeout: 5000,
    pool: false,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message) {
      if (!validMailbox(message.to) || /[\r\n]/.test(message.subject))
        throw new Error("Invalid mail message");
      try {
        const info = await transport.sendMail({
          from: { name: "Quenda", address: config.from },
          to: { address: message.to, name: "" },
          subject: message.subject,
          text: message.text,
          envelope: { from: config.from, to: [message.to] },
        });
        if (info.accepted.length !== 1 || info.rejected.length !== 0)
          throw new Error("Mail not accepted");
      } catch {
        // SMTP errors can contain credentials, recipients and provider responses.
        throw new Error("Mail transport unavailable");
      }
    },
  };
}
