import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Page } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import { useFacilities } from "../catalog/search";

/**
 * Units of another participating municipality, chosen by facility and name
 * from its public catalogue: no private data of that municipality is read.
 */
export function PartnerUnits({
  tenantId,
  index,
  taken,
  onAdd,
}: {
  tenantId: string;
  index: number;
  taken: string[];
  onAdd: (unitId: string) => void;
}) {
  const { locale, t } = usePreferences();
  const facilities = useFacilities(tenantId);
  const [facility, setFacility] = useState("");
  const [unit, setUnit] = useState("");
  const units = useInfiniteQuery({
    queryKey: ["public", tenantId, facility, "units", locale],
    enabled: !!facility,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ id: string; name: string }>>(
        `/api/public/municipalities/${tenantId}/facilities/${facility}/units${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  useEffect(() => {
    // An unsuccessful page needs an explicit retry, never a request loop.
    if (units.hasNextPage && !units.isFetching && !units.isError)
      void units.fetchNextPage();
  }, [units.hasNextPage, units.isFetching, units.isError, units.fetchNextPage]);
  return (
    <>
      <Select
        label={`${t("Instalación", "Instalación")} · ${index}`}
        value={facility}
        placeholder={t(
          "Selecciona una instalación",
          "Selecciona unha instalación",
        )}
        onValueChange={(next) => {
          setFacility(next);
          setUnit("");
        }}
        options={facilities.items.map((f) => ({ value: f.id, label: f.name }))}
      />
      {facility && (
        <Select
          label={`${t("Unidad", "Unidade")} · ${index}`}
          value={unit}
          placeholder={t("Selecciona una unidad", "Selecciona unha unidade")}
          onValueChange={setUnit}
          options={(units.data?.pages.flatMap((page) => page.items) ?? []).map(
            (u) => ({
              value: u.id,
              label: u.name,
              disabled: taken.includes(u.id),
            }),
          )}
        />
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={!unit || taken.includes(unit)}
        onClick={() => {
          onAdd(unit);
          setUnit("");
        }}
      >
        {`${t("Añadir unidad", "Engadir unidade")} · ${index}`}
      </Button>
    </>
  );
}
