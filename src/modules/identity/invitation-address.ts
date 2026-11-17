import { HttpError } from "../../http/errors.ts";
import { validMailbox } from "../../mail/config.ts";

/**
 * Request schema of an invitation address. Format is checked after
 * normalisation, so surrounding spaces and letter case are accepted.
 */
export const invitationAddressSchema = {
  type: "string",
  minLength: 3,
  maxLength: 320,
} as const;

/**
 * Normalises the address an invitation is sent to: trimmed and lower case.
 * Nothing is looked up, so the result never depends on whether an account
 * uses that address.
 */
export function invitationAddress(value: unknown): string {
  if (typeof value !== "string") throw new HttpError("INVALID_INPUT");
  const address = value.trim().toLowerCase();
  if (address.length < 3 || !validMailbox(address))
    throw new HttpError("INVALID_INPUT");
  return address;
}
