import { resolve } from "node:path";

export type MailConfiguration =
  | { kind: "local"; directory: string }
  | {
      kind: "smtp";
      host: string;
      port: number;
      secure: boolean;
      from: string;
      user?: string;
      password?: string;
      servername: string;
      caFile?: string;
    };
export function validMailbox(value: string) {
  return (
    value.length <= 320 &&
    /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(value) &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}
export function readMailConfiguration(
  env: NodeJS.ProcessEnv,
): MailConfiguration {
  const fail = (field: string): never => {
    throw new Error(`Invalid configuration: ${field}`);
  };
  const kind = env.MAIL_TRANSPORT ?? "local";
  if (kind === "local") {
    if (env.NODE_ENV === "production") fail("MAIL_TRANSPORT");
    return { kind, directory: resolve(env.LOCAL_MAIL_DIR ?? ".local/mail") };
  }
  if (kind !== "smtp") return fail("MAIL_TRANSPORT");
  const host = env.SMTP_HOST ?? "",
    from = env.SMTP_FROM ?? "",
    mode = env.SMTP_TLS ?? "starttls";
  if (!host || /[\s/?#@]/.test(host)) fail("SMTP_HOST");
  if (!validMailbox(from)) fail("SMTP_FROM");
  if (mode !== "tls" && mode !== "starttls") fail("SMTP_TLS");
  const rawPort = env.SMTP_PORT ?? (mode === "tls" ? "465" : "587"),
    port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    fail("SMTP_PORT");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) fail("SMTP_AUTH");
  const servername = env.SMTP_SERVERNAME ?? host;
  if (!servername || /[\s/?#@]/.test(servername)) fail("SMTP_SERVERNAME");
  return {
    kind,
    host,
    port,
    secure: mode === "tls",
    from,
    servername,
    ...(env.SMTP_USER
      ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD as string }
      : {}),
    ...(env.SMTP_CA_FILE ? { caFile: resolve(env.SMTP_CA_FILE) } : {}),
  };
}
