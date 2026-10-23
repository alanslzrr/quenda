import { ApiError, api } from "../../app/api.ts";
export const pendingKey = "quenda.reservation-command";
export interface PendingCommand {
  owner: string;
  path: string;
  key: string;
  body: string;
  createdAt: number;
  retentionSeconds: number;
}
export interface CommandPolicy {
  retentionSeconds: number;
  serverTime: string;
}
export function readCommand(
  owner: string,
  storage: Storage = sessionStorage,
): PendingCommand | null {
  try {
    const value = storage.getItem(pendingKey);
    if (!value) return null;
    const item = JSON.parse(value) as PendingCommand;
    if (item.owner !== owner) return null;
    if (
      !/^\/api\/municipalities\/[\da-f-]+(?:\/reservations(?:\/[\da-f-]+\/(?:modify|cancel|accept-usage-rules))?|\/blocks(?:\/[\da-f-]+\/release)?|\/agreements(?:\/[\da-f-]+\/(?:versions|approve|activate|suspend|reports\/\d{4}-(?:0[1-9]|1[0-2])\/reviews))?|\/credentials(?:\/[\da-f-]+\/revoke)?|\/units\/[\da-f-]+\/agreement-restriction\/release)$/.test(
        item.path,
      ) ||
      typeof item.body !== "string" ||
      typeof item.key !== "string" ||
      !Number.isFinite(item.createdAt) ||
      !Number.isFinite(item.retentionSeconds)
    )
      throw new Error("Invalid command");
    const body = JSON.parse(item.body);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid body");
    return item;
  } catch {
    forgetCommand(storage);
    return null;
  }
}
export function forgetCommand(storage: Storage = sessionStorage) {
  try {
    storage.removeItem(pendingKey);
  } catch {
    /* No stored command when storage is unavailable. */
  }
}
export function retryAllowed(
  item: PendingCommand,
  now = Date.now(),
  retention = item.retentionSeconds,
) {
  // Keep a margin before server expiry; expired keys may execute a new command.
  return (
    now >= item.createdAt &&
    now <
      item.createdAt + Math.min(retention, item.retentionSeconds) * 1000 - 5000
  );
}
let inFlight = false;
export async function sendCommand<T>(
  item: PendingCommand,
  locale: "es" | "gl",
  retry = false,
  storage: Storage = sessionStorage,
): Promise<T> {
  const busy = () =>
    new ApiError(
      0,
      "COMMAND_PENDING",
      locale === "es"
        ? "Comprueba la operación anterior antes de enviar otra."
        : "Comproba a operación anterior antes de enviar outra.",
    );
  if (inFlight) throw busy();
  inFlight = true;
  try {
    const existing = readCommand(item.owner, storage);
    if (
      existing &&
      (existing.key !== item.key ||
        existing.body !== item.body ||
        existing.path !== item.path)
    )
      throw busy();
    const policy = await api<CommandPolicy>(
      "/api/public/reservation-command-policy",
      {},
      locale,
    );
    if (
      !retryAllowed(
        item,
        Date.parse(policy.serverTime),
        policy.retentionSeconds,
      )
    )
      throw new ApiError(
        0,
        "RETRY_EXPIRED",
        locale === "es"
          ? "El plazo de reintento ha terminado. Comprueba el resultado antes de enviar otra operación."
          : "O prazo de reintento rematou. Comproba o resultado antes de enviar outra operación.",
      );
    storage.setItem(pendingKey, JSON.stringify(item));
    try {
      const result = await api<T>(
        item.path,
        {
          method: "POST",
          headers: { "Idempotency-Key": item.key },
          body: item.body,
          signal: AbortSignal.timeout(15000),
        },
        locale,
      );
      if (readCommand(item.owner, storage)?.key === item.key)
        forgetCommand(storage);
      return result;
    } catch (error) {
      // A timeout or 5xx does not prove rollback. A rejected replay can also
      // reflect expired MFA or changed permissions after the original commit.
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        !retry &&
        readCommand(item.owner, storage)?.key === item.key
      )
        forgetCommand(storage);
      throw error;
    }
  } finally {
    inFlight = false;
  }
}

export function commandReviewPath(item: PendingCommand) {
  const parts = item.path.split("/");
  const tenant = parts[3];
  const body = JSON.parse(item.body);
  if (parts[4] === "agreements" && parts[6] === "reports")
    return `/administracion/${tenant}/informes/revision`;
  if (parts[4] === "agreements") {
    const version = body.version ?? body.expectedVersion;
    return `/administracion/${tenant}/convenios${parts[5] && Number.isSafeInteger(version) && version > 0 ? `/${parts[5]}/versiones/${version}` : ""}`;
  }
  if (parts[4] === "credentials")
    return `/administracion/${tenant}/acreditaciones`;
  if (parts[4] === "units")
    return `/administracion/${tenant}/convenios/unidades/${parts[5]}/reapertura`;
  const administrative = parts[4] === "blocks" || body.administrative === true;
  return administrative ? `/administracion/${tenant}/agenda` : "/reservas";
}
export interface CommandResult {
  tenantId?: string;
  id?: string;
  agreementId?: string;
  version?: number;
  reviewId?: string;
  decision?: "APPROVE" | "REJECT";
  unitId?: string;
}
export function commandResultPath(item: PendingCommand, result: CommandResult) {
  const review = commandReviewPath(item);
  const parts = item.path.split("/");
  if (parts[4] === "agreements" && parts[6] === "reports") return review;
  if (parts[4] === "agreements")
    return result.agreementId && result.version
      ? `/administracion/${parts[3]}/convenios/${result.agreementId}/versiones/${result.version}`
      : review;
  if (parts[4] === "credentials")
    return result.id
      ? `${review}?referencia=${encodeURIComponent(result.id)}`
      : review;
  if (parts[4] === "units") return review;
  if (review === "/reservas")
    return `/reservas/${result.tenantId}/${result.id}`;
  return parts[4] === "blocks"
    ? review
    : `/administracion/${result.tenantId}/reservas/${result.id}`;
}
