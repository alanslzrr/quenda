import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HttpError } from "../../http/errors.ts";

const operations: Record<string, string> = {
  "/sign-up/email": "SIGN_UP",
  "/sign-in/email": "SIGN_IN",
  "/sign-out": "SIGN_OUT",
  "/verify-email": "VERIFY_EMAIL",
  "/send-verification-email": "SEND_VERIFICATION",
  "/request-password-reset": "REQUEST_RESET",
  "/reset-password": "RESET_PASSWORD",
  "/change-password": "CHANGE_PASSWORD",
  "/update-user": "UPDATE_PROFILE",
  "/revoke-session": "REVOKE_SESSION",
  "/revoke-sessions": "REVOKE_SESSIONS",
  "/revoke-other-sessions": "REVOKE_OTHER_SESSIONS",
  "/two-factor/enable": "MFA_ENABLE",
  "/two-factor/disable": "MFA_DISABLE",
  "/two-factor/verify-totp": "MFA_TOTP",
  "/two-factor/verify-backup-code": "MFA_BACKUP",
  "/two-factor/generate-backup-codes": "MFA_GENERATE_BACKUP",
  "/two-factor/get-totp-uri": "MFA_GET_URI",
};
const sessionOperations = new Set([
  "SIGN_OUT",
  "CHANGE_PASSWORD",
  "UPDATE_PROFILE",
  "REVOKE_SESSION",
  "REVOKE_SESSIONS",
  "REVOKE_OTHER_SESSIONS",
  "MFA_ENABLE",
  "MFA_DISABLE",
  "MFA_GENERATE_BACKUP",
  "MFA_GET_URI",
]);

export function auditedAuthenticationHandler(
  pool: Pool,
  handler: (request: Request) => Promise<Response>,
  verifiedActor: (headers: Headers) => Promise<string | null>,
) {
  return async (request: Request, requestId: string = randomUUID()) => {
    const path = new URL(request.url).pathname.slice("/api/auth".length);
    const operation = Object.hasOwn(operations, path)
      ? operations[path]
      : undefined;
    if (!operation || (request.method !== "POST" && path !== "/verify-email"))
      return handler(request);
    const actor = sessionOperations.has(operation)
      ? await verifiedActor(request.headers)
      : null;
    const record = async (phase: string, status: number | null = null) => {
      try {
        await pool.query("SELECT auth.record_request_event($1,$2,$3,$4,$5)", [
          requestId,
          phase,
          operation,
          actor,
          status,
        ]);
      } catch {
        throw new HttpError("UNAVAILABLE");
      }
    };
    await record("RECEIVED");
    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      await record("THREW");
      throw error;
    }
    await record("RETURNED", response.status);
    return response;
  };
}
