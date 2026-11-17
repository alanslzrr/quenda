import { useQuery } from "@tanstack/react-query";
import { api } from "../../app/api";
import { useMunicipality as usePublicMunicipality } from "../../app/branding";
import { usePreferences } from "../../app/preferences-provider";
import { endpoint, useMunicipality, useMunicipalPages } from "./shared";

// Agreements and grants store identifiers. These read the names people use
// from data already open to the reader: the municipality's own unit list and
// the public catalogue. Anything not resolvable keeps its identifier.

/** A participating municipality by its public name. */
export function MunicipalityName({ id }: { id: string }) {
  const own = useMunicipality();
  const other = usePublicMunicipality(id === own.id ? undefined : id);
  return <>{id === own.id ? own.name : (other.data?.name ?? id)}</>;
}

/** A unit by name and facility, for the acting or another municipality. */
export function UnitName({ tenantId, id }: { tenantId: string; id: string }) {
  const own = useMunicipality();
  const { locale } = usePreferences();
  const units = useMunicipalPages<{ id: string; name: string }>(
    `${endpoint(own.id)}/agenda/units`,
    tenantId === own.id,
  );
  const listed = units.data?.pages
    .flatMap((p) => p.items)
    .find((u) => u.id === id)?.name;
  const published = useQuery({
    queryKey: ["public", tenantId, id, "unit-name", locale],
    enabled: !listed && (tenantId !== own.id || !units.isPending),
    retry: false,
    queryFn: ({ signal }) =>
      api<{ name: string; facilityName: string }>(
        `/api/public/municipalities/${tenantId}/units/${id}`,
        { signal },
        locale,
      ),
  });
  const name =
    listed ??
    (published.data
      ? `${published.data.name} · ${published.data.facilityName}`
      : undefined);
  return <>{name ?? id}</>;
}
