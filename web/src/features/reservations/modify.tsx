import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import { PageTitle } from "../account/shared";
import { type Unit, UnitAvailability } from "../catalog/unit";
import {
  detailPath,
  PendingLink,
  ReservationSummary,
  useReservation,
} from "./shared";
export function ModifyReservation() {
  useMunicipalTheme(undefined);
  const { tenantId = "", reservationId = "" } = useParams();
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const reservation = useReservation(tenantId, reservationId);
  const [facility, setFacility] = useState("");
  const [selectedUnit, setSelectedUnit] = useState("");
  const facilities = useInfiniteQuery({
    queryKey: ["public", tenantId, "facilities", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ id: string; name: string }>>(
        `/api/public/municipalities/${tenantId}/facilities${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
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
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const unitId =
    selectedUnit || (!facility ? reservation.data?.unitId : undefined);
  const unit = useQuery({
    queryKey: ["public", tenantId, unitId, "calendar", locale],
    enabled: !!unitId,
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${unitId}`,
        { signal },
        locale,
      ),
  });
  if (reservation.isPending) return <Loading />;
  if (reservation.isError) return <Failure error={reservation.error} />;
  return (
    <>
      <Link to={detailPath(tenantId, reservationId)}>
        {t("Volver a la reserva", "Volver á reserva")}
      </Link>
      <PageTitle title={t("Modificar reserva", "Modificar reserva")}>
        {t(
          "La reserva actual se mantiene hasta confirmar el cambio.",
          "A reserva actual mantense ata confirmar o cambio.",
        )}
      </PageTitle>
      <PendingLink />
      <ReservationSummary reservation={reservation.data} />
      <section className={styles.section}>
        <Select
          label={t("Cambiar instalación", "Cambiar instalación")}
          value={facility}
          placeholder={t(
            "Selecciona una instalación",
            "Selecciona unha instalación",
          )}
          onValueChange={(value) => {
            setFacility(value);
            setSelectedUnit("");
          }}
          options={
            facilities.data?.pages
              .flatMap((p) => p.items)
              .map((f) => ({ value: f.id, label: f.name })) ?? []
          }
        />
        {facilities.isError && (
          <Failure
            error={facilities.error}
            retry={() => void facilities.refetch()}
          />
        )}
        {facilities.hasNextPage && (
          <Button onClick={() => void facilities.fetchNextPage()}>
            {t("Ver más instalaciones", "Ver máis instalacións")}
          </Button>
        )}
        {facility && (
          <>
            <Select
              label={t("Unidad reservable", "Unidade reservable")}
              value={selectedUnit}
              placeholder={t(
                "Selecciona una unidad",
                "Selecciona unha unidade",
              )}
              onValueChange={setSelectedUnit}
              options={
                units.data?.pages
                  .flatMap((p) => p.items)
                  .map((u) => ({ value: u.id, label: u.name })) ?? []
              }
            />
            {units.isError && (
              <Failure error={units.error} retry={() => void units.refetch()} />
            )}
            {units.hasNextPage && (
              <Button onClick={() => void units.fetchNextPage()}>
                {t("Ver más unidades", "Ver máis unidades")}
              </Button>
            )}
          </>
        )}
      </section>
      {unitId &&
        (unit.isPending ? (
          <Loading />
        ) : unit.isError ? (
          <Failure error={unit.error} retry={() => void unit.refetch()} />
        ) : (
          <UnitAvailability
            key={unitId}
            tenantId={tenantId}
            unit={unit.data}
            reservationId={reservationId}
            owner={account?.accountId}
          />
        ))}
    </>
  );
}
