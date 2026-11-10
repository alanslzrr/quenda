import { encode } from "uqr";

/** Module matrix with a four-module quiet zone; true is a dark module. */
export const accessCodeModules = (value: string) =>
  encode(value, { ecc: "M", border: 4 });

/** The staff page a reservation's access code opens. */
export const accessCodeTarget = (
  origin: string,
  tenantId: string,
  reservationId: string,
) => `${origin}/administracion/${tenantId}/reservas/${reservationId}`;
