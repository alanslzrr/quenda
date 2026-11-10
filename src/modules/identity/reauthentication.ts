import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { AuthenticatedAccount } from "./auth.ts";

// A five-minute proof window limits sensitive operations without shortening
// the ordinary session. This is a Quenda policy, not a Better Auth default.
export const administrativeProofLifetimeMs = 5 * 60 * 1000;

// A session of an MFA account that has not proved the factor yet (for example
// the one issued by a password change) is repaired by verifying it, exactly
// like a lapsed proof. Without MFA the account cannot hold the authority.
export function requireMfaSession(
  account: AuthenticatedAccount,
): asserts account is AuthenticatedAccount & { mfaVerifiedAt: Date } {
  if (!account.mfaVerifiedAt)
    throw new HttpError(
      account.mfaEnabled ? "REAUTHENTICATION_REQUIRED" : "FORBIDDEN",
    );
}

export function requireRecentMfa(
  account: AuthenticatedAccount,
  clock: Clock = systemClock,
): void {
  requireMfaSession(account);
  const age = clock.now().getTime() - account.mfaVerifiedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age >= administrativeProofLifetimeMs)
    throw new HttpError("REAUTHENTICATION_REQUIRED");
}
