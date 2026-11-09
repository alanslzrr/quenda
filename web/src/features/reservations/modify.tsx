import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ApiError, api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { isUuid } from "../../app/ids.ts";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Select } from "../../ui/select/select";
import { BackLink, BookingSummary } from "../catalog/booking";
import booking from "../catalog/booking.module.css";
import { municipalToday } from "../catalog/dates";
import { useMunicipality } from "../catalog/municipality";
import { useFacilities } from "../catalog/search";
import { type Unit, UnitAvailability } from "../catalog/unit";
import { detailPath, PendingLink, useReservation } from "./shared";

export function ModifyReservation() {
  useMunicipalTheme(undefined);
  const { tenantId = "", reservationId = "" } = useParams();
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const [search, setSearch] = useSearchParams();
  const reservation = useReservation(tenantId, reservationId);
  const municipality = useMunicipality(tenantId);
  const facilities = useFacilities(tenantId);
  const current = useQuery({
    queryKey: [
      "public",
      tenantId,
      reservation.data?.unitId,
      "calendar",
      locale,
    ],
    enabled: !!reservation.data,
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${reservation.data?.unitId}`,
        { signal },
        locale,
      ),
  });
  // Returning from the change review restores the chosen space.
  const [facility, setFacility] = useState<string | undefined>(() => {
    const value = search.get("instalacion");
    return isUuid(value ?? undefined) ? (value ?? undefined) : undefined;
  });
  const [selectedUnit, setSelectedUnit] = useState<string | undefined>(() => {
    const value = search.get("unidad");
    return isUuid(value ?? undefined) ? (value ?? undefined) : undefined;
  });
  const facilityId = facility ?? current.data?.facilityId ?? "";
  const unitId =
    selectedUnit ?? (facility === undefined ? current.data?.id : undefined);
  const units = useInfiniteQuery({
    queryKey: ["public", tenantId, facilityId, "units", locale],
    enabled: !!facilityId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ id: string; name: string }>>(
        `/api/public/municipalities/${tenantId}/facilities/${facilityId}/units${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    retry: false,
    refetchOnMount: (q) => !q.state.error,
    refetchOnWindowFocus: (q) => !q.state.error,
    refetchOnReconnect: (q) => !q.state.error,
  });
  useEffect(() => {
    if (units.hasNextPage && !units.isFetching && !units.isError)
      void units.fetchNextPage();
  }, [units.hasNextPage, units.isFetching, units.isError, units.fetchNextPage]);
  const target = useQuery({
    queryKey: ["public", tenantId, unitId, "calendar", locale],
    enabled: !!unitId,
    queryFn: ({ signal }) =>
      api<Unit>(
        `/api/public/municipalities/${tenantId}/units/${unitId}`,
        { signal },
        locale,
      ),
  });
  const failures = [facilities, units].filter((q) => q.isError);
  const retryError = failures
    .map((q) => q.error)
    .sort(
      (a, b) =>
        (b instanceof ApiError ? (b.retryAt ?? 0) : 0) -
        (a instanceof ApiError ? (a.retryAt ?? 0) : 0),
    )[0];
  const r = reservation.data;
  const seeded = search.has("fecha") || search.has("duracion");
  useEffect(() => {
    if (!r || seeded) return;
    const day = municipalToday(r.timeZone, new Date(r.startsAt));
    const minutes = (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 60000;
    setSearch(
      (params) => {
        const next = new URLSearchParams(params);
        next.set("fecha", day);
        next.set("duracion", String(minutes));
        return next;
      },
      { replace: true },
    );
  }, [r, seeded, setSearch]);
  if (reservation.isPending) return <Loading />;
  if (reservation.isError)
    return (
      <Failure
        error={reservation.error}
        retry={() => void reservation.refetch()}
      />
    );
  if (!r) return null;
  const currentFacility = current.data?.facilityName;
  const unitOptions =
    units.data?.pages
      .flatMap((p) => p.items)
      .map((u) => ({ value: u.id, label: u.name })) ?? [];
  return (
    <div className={booking.page}>
      <BackLink to={detailPath(tenantId, reservationId)}>
        {t("Volver a la reserva", "Volver á reserva")}
      </BackLink>
      <header className={booking.intro}>
        <h1 className={booking.title}>
          {t("Cambiar horario", "Cambiar horario")}
        </h1>
        <p className={booking.lead}>
          {t(
            "Tu reserva actual se mantiene hasta que confirmes el cambio.",
            "A túa reserva actual mantense ata que confirmes o cambio.",
          )}
        </p>
      </header>
      <PendingLink />
      <div className={booking.split}>
        <BookingSummary
          context={[
            t("Reserva actual", "Reserva actual"),
            municipality.data?.name,
            currentFacility,
          ]
            .filter(Boolean)
            .join(" · ")}
          unitName={
            current.data?.name ?? t("Espacio reservado", "Espazo reservado")
          }
          startsAt={r.startsAt}
          endsAt={r.endsAt}
          timeZone={r.timeZone}
        />
        <div className={booking.main}>
          <div className={booking.search} data-fields={2}>
            <Select
              label={t("Instalación", "Instalación")}
              value={facilityId}
              placeholder={t(
                "Selecciona una instalación",
                "Selecciona unha instalación",
              )}
              onValueChange={(value) => {
                setFacility(value);
                setSelectedUnit(
                  value === current.data?.facilityId
                    ? current.data.id
                    : undefined,
                );
              }}
              options={facilities.items.map((f) => ({
                value: f.id,
                label: f.name,
              }))}
            />
            <Select
              label={t("Espacio", "Espazo")}
              value={unitId ?? ""}
              placeholder={t("Selecciona un espacio", "Selecciona un espazo")}
              onValueChange={setSelectedUnit}
              options={unitOptions}
            />
          </div>
          {(facilities.isError || units.isError) && (
            <Failure
              error={retryError}
              retryBusy={facilities.isFetching || units.isFetching}
              retry={() => {
                for (const query of failures) void query.refetch();
              }}
            />
          )}
          {unitId &&
            seeded &&
            (target.isPending ? (
              <Loading />
            ) : target.isError ? (
              <Failure
                error={target.error}
                retry={() => void target.refetch()}
              />
            ) : (
              <UnitAvailability
                key={unitId}
                tenantId={tenantId}
                unit={target.data}
                reservationId={reservationId}
                owner={account?.accountId}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
