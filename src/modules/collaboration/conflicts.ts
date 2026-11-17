import type { DatabaseError } from "pg";
import type { ErrorCode } from "../../http/errors.ts";

// Raised by the agreement functions when the caller worked from a version
// that another administrator has already replaced.
const superseded = new Set(["Version conflict", "Superseded version"]);

/** Names the cause of an agreement command rejected by a database rule. */
export function agreementRejection(error: DatabaseError): ErrorCode {
  return superseded.has(error.message)
    ? "STALE_VERSION"
    : "AGREEMENT_STATE_CONFLICT";
}
