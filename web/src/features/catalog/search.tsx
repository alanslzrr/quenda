import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { durationLabel, localTimeLabel, municipalToday } from "./dates";
import type { Availability } from "./unit";
import styles from "./unit.module.css";

export function AvailabilitySearch({
  tenantId,
  timeZone,
}: {
  tenantId: string;
  timeZone: string;
}) {
  const { locale, t } = usePreferences();
  const [date, setDate] = useState(() => municipalToday(timeZone));
  const [choice, setChoice] = useState<number>();
  const [expanded, setExpanded] = useState<string[]>([]);
  const durations = useQuery({
    queryKey: ["public", tenantId, "durations"],
    queryFn: ({ signal }) =>
      api<{ durations: number[] }>(
        `/api/public/municipalities/${tenantId}/booking-durations`,
        { signal },
        locale,
      ),
  });
  const duration = choice ?? durations.data?.durations[0];
  const query = useInfiniteQuery({
    queryKey: [
      "public",
      tenantId,
      "availability-search",
      date,
      duration,
      locale,
    ],
    initialPageParam: null as string | null,
    enabled: !!duration && /^\d{4}-\d{2}-\d{2}$/.test(date),
    queryFn: ({ pageParam, signal }) =>
      api<
        Page<Availability & { id: string; name: string; facilityName: string }>
      >(
        `/api/public/municipalities/${tenantId}/availability-search?date=${date}&durationMinutes=${duration}${pageParam ? `&after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-label={t("Buscar horarios", "Buscar horarios")}>
      <div className={styles.searchFilters}>
        <Input
          label={t("¿Qué día?", "Que día?")}
          type="date"
          value={date}
          min={municipalToday(timeZone)}
          onChange={(event) => setDate(event.target.value)}
        />
        <Select
          label={t("¿Cuánto tiempo necesitas?", "Canto tempo precisas?")}
          value={duration === undefined ? "" : String(duration)}
          onValueChange={(value) => setChoice(Number(value))}
          options={(durations.data?.durations ?? []).map((value) => ({
            value: String(value),
            label: durationLabel(value),
          }))}
        />
      </div>
      {durations.isError ? (
        <Failure
          error={durations.error}
          retry={() => void durations.refetch()}
        />
      ) : durations.isPending ? (
        <Loading />
      ) : !duration ? (
        <p>
          {t(
            "No hay unidades preparadas para reservar.",
            "Non hai unidades preparadas para reservar.",
          )}
        </p>
      ) : query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <p className={styles.zone}>
            {t(
              "Horarios en la hora local del municipio. Elige uno para revisar tu reserva.",
              "Horarios na hora local do municipio. Escolle un para revisar a túa reserva.",
            )}
          </p>
          {items.map((unit) => (
            <article className={styles.result} key={unit.id}>
              <p className={styles.eyebrow}>{unit.facilityName}</p>
              <h2>
                <Link
                  to={`/municipios/${tenantId}/unidades/${unit.id}?fecha=${date}&duracion=${duration}`}
                >
                  {unit.name}
                </Link>
              </h2>
              <ul className={styles.slots}>
                {(expanded.includes(unit.id)
                  ? unit.slots
                  : unit.slots.slice(0, 8)
                ).map((slot) => (
                  <li key={slot.start.utc}>
                    <Link
                      className={styles.slot}
                      to={`/municipios/${tenantId}/unidades/${unit.id}/reservar?inicio=${encodeURIComponent(slot.start.utc)}&fin=${encodeURIComponent(slot.end.utc)}`}
                    >
                      <span>
                        {localTimeLabel(slot.start.utc, unit.timeZone, locale)}{" "}
                        – {localTimeLabel(slot.end.utc, unit.timeZone, locale)}
                      </span>
                      <small>
                        {slot.start.local.slice(0, 10) !==
                        slot.end.local.slice(0, 10)
                          ? t(
                              "Termina al día siguiente",
                              "Remata ao día seguinte",
                            )
                          : t("Elegir", "Escoller")}
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
              {unit.slots.length > 8 && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setExpanded((current) =>
                      current.includes(unit.id)
                        ? current.filter((id) => id !== unit.id)
                        : [...current, unit.id],
                    )
                  }
                >
                  {expanded.includes(unit.id)
                    ? t("Ver menos horarios", "Ver menos horarios")
                    : t("Ver todos los horarios", "Ver todos os horarios")}
                </Button>
              )}
            </article>
          ))}
          {!items.length && !query.hasNextPage && (
            <div className={styles.empty}>
              <p>
                {t(
                  "No hay horarios disponibles para esta fecha y duración.",
                  "Non hai horarios dispoñibles para esta data e duración.",
                )}
              </p>
              <span>
                {t(
                  "Prueba otro día o una duración diferente.",
                  "Proba outro día ou unha duración diferente.",
                )}
              </span>
            </div>
          )}
          {query.hasNextPage && (
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("Buscar en más instalaciones", "Buscar en máis instalacións")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
