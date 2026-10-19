import {
  type MailConfiguration,
  readMailConfiguration,
} from "./mail/config.ts";

export const defaultIdempotencyRetentionSeconds = 86400;

export interface Config {
  idempotencyRetentionSeconds: number;
  host: string;
  port: number;
  logLevel: "silent" | "error" | "warn" | "info" | "debug";
  domainDatabaseUrl: string;
  authDatabaseUrl: string;
  databasePoolMax: number;
  authOrigin: string;
  authSecret: string;
  mail: MailConfiguration;
}

export class ConfigurationError extends Error {
  constructor(field: string) {
    super(`Invalid configuration: ${field}`);
    this.name = "ConfigurationError";
  }
}

function integer(
  value: string,
  field: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(value)) throw new ConfigurationError(field);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ConfigurationError(field);
  }
  return number;
}

function databaseUrl(env: NodeJS.ProcessEnv, field: string): URL {
  try {
    const url = new URL(env[field] ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2
    )
      throw new Error();
    return url;
  } catch {
    throw new ConfigurationError(field);
  }
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  for (const key of Object.keys(env)) {
    if (env[key] && /^(MIGRATION|BOOTSTRAP)_/.test(key)) {
      throw new ConfigurationError(key);
    }
  }
  const domain = databaseUrl(env, "DOMAIN_DATABASE_URL");
  const auth = databaseUrl(env, "AUTH_DATABASE_URL");
  if (domain.username === auth.username)
    throw new ConfigurationError("AUTH_DATABASE_URL");
  if (domain.host !== auth.host || domain.pathname !== auth.pathname) {
    throw new ConfigurationError("AUTH_DATABASE_URL");
  }
  const level = env.LOG_LEVEL ?? "info";
  if (!["silent", "error", "warn", "info", "debug"].includes(level)) {
    throw new ConfigurationError("LOG_LEVEL");
  }
  const host = env.HOST ?? "127.0.0.1";
  if (!host || /\s/.test(host)) throw new ConfigurationError("HOST");
  let origin: URL;
  try {
    origin = new URL(env.AUTH_ORIGIN ?? "");
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
      )
    )
      throw new Error();
  } catch {
    throw new ConfigurationError("AUTH_ORIGIN");
  }
  if (env.NODE_ENV === "production" && origin.protocol !== "https:")
    throw new ConfigurationError("AUTH_ORIGIN");
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32)
    throw new ConfigurationError("AUTH_SECRET");
  let mail: MailConfiguration;
  try {
    mail = readMailConfiguration(env);
  } catch {
    throw new ConfigurationError("MAIL_TRANSPORT");
  }
  return {
    idempotencyRetentionSeconds: integer(
      env.IDEMPOTENCY_RETENTION_SECONDS ??
        String(defaultIdempotencyRetentionSeconds),
      "IDEMPOTENCY_RETENTION_SECONDS",
      1,
      2147483647,
    ),
    host,
    port: integer(env.PORT ?? "3000", "PORT", 1, 65535),
    databasePoolMax: integer(
      env.DATABASE_POOL_MAX ?? "5",
      "DATABASE_POOL_MAX",
      1,
      100,
    ),
    logLevel: level as Config["logLevel"],
    domainDatabaseUrl: domain.href,
    authDatabaseUrl: auth.href,
    authOrigin: origin.origin,
    authSecret: env.AUTH_SECRET,
    mail,
  };
}
