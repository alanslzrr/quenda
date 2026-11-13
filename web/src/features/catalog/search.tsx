import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Alert } from "../../ui/alert/alert";
import { Button } from "../../ui/button/button";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { Select } from "../../ui/select/select";
import {
  bookingQuery,
  DateField,
  DurationField,
  MoreLink,
  type Slot,
  SlotList,
  useBookingParams,
} from "./booking";
import styles from "./booking.module.css";
import { calendarDate, durationLabel } from "./dates";
import type { CatalogPhoto } from "./photos";
import type { FacilityProfile } from "./profile";

interface SearchResult {
  id: string;
  name: string;
  facilityId: string;
  facilityName: string;
  timeZone: string;
  slots: Slot[];
}
const visibleSlots = 8;

export interface Facility {
  id: string;
  name: string;
  /** Units a visitor can book right now. */
  units: number;
  profile?: FacilityProfile;
  photos?: CatalogPhoto[];
}

export function useFacilities(tenantId: string) {
  const { locale } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: ["public", tenantId, "facilities", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Facility>>(
        `/api/public/municipalities/${tenantId}/facilities${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    refetchOnMount: (q) => !q.state.error,
    refetchOnWindowFocus: (q) => !q.state.error,
    refetchOnReconnect: (q) => !q.state.error,
  });
  useEffect(() => {
    // An unsuccessful page needs an explicit retry, never an automatic request loop.
    if (query.hasNextPage && !query.isFetching && !query.isError)
      void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  return {
    ...query,
    loading:
      query.isPending || (!query.isError && (query.hasNextPage ?? false)),
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

export function AvailabilitySearch({
  tenantId,
  timeZone,
}: {
  tenantId: string;
  timeZone: string;
}) {
  const { locale, t } = usePreferences();
  const params = useBookingParams(timeZone);
  const all = useFacilities(tenantId);
  const facilities = {
    ...all,
    items: all.items.filter((item) => item.units > 0),
  };
  const durations = useQuery({
    queryKey: ["public", tenantId, "durations"],
    queryFn: ({ signal }) =>
      api<{ durations: number[]; hasMore?: boolean; recommended?: number }>(
        `/api/public/municipalities/${tenantId}/booking-durations`,
        { signal },
        locale,
      ),
  });
  const options = durations.data?.durations ?? [];
  const open = durations.data?.hasMore ?? false;
  const requested = params.duration;
  const duration =
    requested && (open || options.includes(requested))
      ? requested
      : (durations.data?.recommended ?? options[0]);
  const facility = facilities.items.some((item) => item.id === params.facility)
    ? params.facility
    : "";
  const query = useInfiniteQuery({
    queryKey: [
      "public",
      tenantId,
      "availability-search",
      params.date,
      duration,
      facility,
      locale,
    ],
    initialPageParam: null as string | null,
    // A requested facility is applied only once the list can confirm it; never search everything meanwhile.
    enabled: !!duration && duration > 0 && !(params.facility && all.loading),
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams({
        date: params.date,
        durationMinutes: String(duration),
      });
      if (facility) search.set("facilityId", facility);
      if (pageParam) search.set("after", pageParam);
      return api<Page<SearchResult>>(
        `/api/public/municipalities/${tenantId}/availability-search?${search}`,
        { signal },
        locale,
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // A page can be empty while the scan continues; keep scanning until something is found.
  useEffect(() => {
    if (
      !items.length &&
      query.hasNextPage &&
      !query.isFetching &&
      !query.isError
    )
      void query.fetchNextPage();
  }, [
    items.length,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
  ]);
  const order = new Map(
    facilities.items.map((item, index) => [item.id, index]),
  );
  const groups = [
    ...items
      .reduce((all, item) => {
        const group = all.get(item.facilityId) ?? {
          id: item.facilityId,
          name: item.facilityName,
          units: [] as SearchResult[],
        };
        group.units.push(item);
        return all.set(item.facilityId, group);
      }, new Map<string, { id: string; name: string; units: SearchResult[] }>())
      .values(),
  ]
    .sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name, locale),
    )
    .map((group) => ({
      ...group,
      units: group.units.sort((a, b) => a.name.localeCompare(b.name, locale)),
    }));
  const day = calendarLabel(calendarDate(params.date), locale, "day");
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const facilityDropped =
    !!params.facility && !all.loading && !all.isError && facility === "";
  const durationDropped =
    requested !== undefined &&
    durations.isSuccess &&
    duration !== undefined &&
    duration !== requested;
  const scanning =
    query.isLoading ||
    (!query.isError && !items.length && (query.hasNextPage ?? false));
  return (
    <section aria-label={t("Buscar horarios", "Buscar horarios")}>
      {params.dateAdjusted && (
        <Alert
          className={styles.adjusted}
          tone="info"
          title={t(
            "El día elegido no es válido o ya ha pasado; mostramos hoy.",
            "O día elixido non é válido ou xa pasou; amosamos hoxe.",
          )}
        />
      )}
      {facilityDropped && (
        <Alert
          className={styles.adjusted}
          tone="info"
          title={t(
            "La instalación elegida ya no está disponible; mostramos todas.",
            "A instalación elixida xa non está dispoñible; amosamos todas.",
          )}
        />
      )}
      {durationDropped && (
        <Alert
          className={styles.adjusted}
          tone="info"
          title={t(
            "La duración elegida no se admite aquí; mostramos la recomendada.",
            "A duración elixida non se admite aquí; amosamos a recomendada.",
          )}
        />
      )}
      <div
        className={styles.search}
        data-fields={facilities.items.length > 1 ? 3 : 2}
      >
        <DateField
          date={params.date}
          today={params.today}
          onChange={(date) => params.update({ fecha: date })}
        />
        {durations.isPending ? (
          <Loading />
        ) : (
          <DurationField
            value={duration}
            options={options}
            range={open ? { minimum: options[0] ?? 1, step: 1 } : undefined}
            onChange={(minutes) =>
              params.update({
                duracion: Number.isInteger(minutes) ? String(minutes) : "",
              })
            }
          />
        )}
        {facilities.items.length > 1 && (
          <Select
            label={t("Instalación", "Instalación")}
            value={facility || "all"}
            onValueChange={(value) =>
              params.update({ instalacion: value === "all" ? "" : value })
            }
            options={[
              {
                value: "all",
                label: t("Todas las instalaciones", "Todas as instalacións"),
              },
              ...facilities.items.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
        )}
      </div>
      {facilities.isError && (
        <Failure
          error={facilities.error}
          retry={() => void facilities.refetch()}
        />
      )}
      <div className={styles.results} aria-live="polite" aria-busy={scanning}>
        {durations.isError ? (
          <Failure
            error={durations.error}
            retry={() => void durations.refetch()}
          />
        ) : durations.isPending ? null : !duration ? (
          <div className={styles.empty}>
            <p>
              {t(
                "Todavía no hay espacios disponibles para reservar.",
                "Aínda non hai espazos dispoñibles para reservar.",
              )}
            </p>
          </div>
        ) : (
          <>
            <div className={styles.resultsHead}>
              <h2>{t("Horarios libres", "Horarios libres")}</h2>
              <p>
                {day} · {durationLabel(duration)}
              </p>
            </div>
            {browserZone !== timeZone && (
              <p className={styles.timeZone}>
                {t(
                  `Horas locales del municipio (${timeZone}).`,
                  `Horas locais do municipio (${timeZone}).`,
                )}
              </p>
            )}
            {query.isError ? (
              <Failure error={query.error} retry={() => void query.refetch()} />
            ) : scanning ? (
              <Loading />
            ) : !items.length ? (
              <div className={styles.empty}>
                <p>
                  {t(
                    `No quedan horarios libres de ${durationLabel(duration)} este día.`,
                    `Non quedan horarios libres de ${durationLabel(duration)} este día.`,
                  )}
                </p>
                <span>
                  {facility
                    ? t(
                        "Prueba otro día, otra duración o todas las instalaciones.",
                        "Proba outro día, outra duración ou todas as instalacións.",
                      )
                    : t(
                        "Prueba otro día u otra duración.",
                        "Proba outro día ou outra duración.",
                      )}
                </span>
              </div>
            ) : (
              groups.map((group) => (
                <section
                  className={styles.group}
                  key={group.id}
                  aria-labelledby={`facility-${group.id}`}
                >
                  <h2 id={`facility-${group.id}`} className={styles.groupTitle}>
                    {group.name}
                  </h2>
                  <ul className={styles.units}>
                    {group.units.map((unit) => {
                      const unitPath = `/municipios/${tenantId}/unidades/${unit.id}${bookingQuery({ date: params.date, duration })}`;
                      return (
                        <li className={styles.unit} key={unit.id}>
                          <div className={styles.unitHead}>
                            <h3 className={styles.unitName}>
                              <Link to={unitPath}>{unit.name}</Link>
                            </h3>
                            {unit.slots.length > visibleSlots && (
                              <MoreLink to={unitPath}>
                                {t(
                                  `Ver los ${unit.slots.length} horarios`,
                                  `Ver os ${unit.slots.length} horarios`,
                                )}
                              </MoreLink>
                            )}
                          </div>
                          <SlotList
                            slots={unit.slots}
                            timeZone={unit.timeZone}
                            limit={visibleSlots}
                            href={(slot) =>
                              `/municipios/${tenantId}/unidades/${unit.id}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
            {!!items.length && query.hasNextPage && (
              <Button
                className={styles.loadMore}
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("Mostrar más espacios", "Amosar máis espazos")}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
