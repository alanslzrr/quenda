import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { AuthenticatedAccount } from "./auth.ts";

// A five-minute proof window limits sensitive operations without shortening
// the ordinary session. This is a Quenda policy, not a Better Auth default.
export const administrativeProofLifetimeMs = 5 * 60 * 1000;

export function requireRecentMfa(
  account: AuthenticatedAccount,
  clock: Clock = systemClock,
): void {
  if (!account.mfaVerifiedAt) throw new HttpError("FORBIDDEN");
  const age = clock.now().getTime() - account.mfaVerifiedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age >= administrativeProofLifetimeMs)
    throw new HttpError("REAUTHENTICATION_REQUIRED");
}
