import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../app/api";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import { calendarDate, durationLabel } from "../catalog/dates";
import styles from "./reservations.module.css";

export interface Recommendation {
  tenantId: string;
  municipality: string;
  unitId: string;
  unitName: string;
  facilityName: string;
  weekday: number;
  startMinute: number;
  durationMinutes: number;
  occurrences: number;
  slot: {
    start: { utc: string; local: string };
    end: { utc: string; local: string };
  };
}
export interface Recommendations {
  enabled: boolean;
  items: Recommendation[];
}

// ISO weekday (1 = Monday) in the plural used for a habit: "los martes".
const habitualDays = {
  es: [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábados",
    "domingos",
  ],
  gl: ["luns", "martes", "mércores", "xoves", "venres", "sábados", "domingos"],
};
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** One cache entry for the list and for the switch in account privacy. */
export function useRecommendations() {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useQuery({
    queryKey: ["private", account?.accountId, "recommendations", locale],
    queryFn: ({ signal }) =>
      api<Recommendations>("/api/me/recommendations", { signal }, locale),
    enabled: !!account,
  });
}
export function useRecommendationSwitch() {
  const { account } = useSession();
  const { locale } = usePreferences();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ enabled: boolean }>(
        "/api/me/recommendations",
        { method: "PUT", body: JSON.stringify({ enabled }) },
        locale,
      ),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["private", account?.accountId, "recommendations"],
      }),
  });
}

/**
 * The holder's habitual slots, offered again with their next free date. Shown
 * only when there is something to offer; a failure leaves the page as it was.
 */
export function HabitualSlots() {
  const { locale, t } = usePreferences();
  const query = useRecommendations();
  const turnOff = useRecommendationSwitch();
  if (!query.data?.enabled || !query.data.items.length) return null;
  return (
    <section
      className={styles.recommendations}
      aria-labelledby="habitual-slots"
    >
      <h2 id="habitual-slots">
        {t("Tus horarios habituales", "Os teus horarios habituais")}
      </h2>
      <p className={styles.recommendationsNote}>
        {t(
          "Según las reservas que repites desde hace seis meses. Solo las ves tú y no se guardan.",
          "Segundo as reservas que repites desde hai seis meses. Só as ves ti e non se gardan.",
        )}
      </p>
      <ul className={styles.rows}>
        {query.data.items.map((item) => {
          const day = calendarLabel(
            calendarDate(item.slot.start.local.slice(0, 10)),
            locale,
            "short",
          );
          const time = item.slot.start.local.slice(11, 16);
          const label = t(
            `Reservar el ${day} · ${time}`,
            `Reservar o ${day} · ${time}`,
          );
          return (
            <li
              key={`${item.tenantId}:${item.unitId}:${item.slot.start.utc}`}
              className={styles.recommendation}
            >
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{item.unitName}</span>
                <span className={styles.rowMeta}>
                  {item.facilityName} · {item.municipality}
                </span>
                <span className={styles.rowMeta}>
                  {t(
                    `Sueles reservar los ${habitualDays.es[item.weekday - 1]} a las ${clock(item.startMinute)}, ${durationLabel(item.durationMinutes)}.`,
                    `Adoitas reservar os ${habitualDays.gl[item.weekday - 1]} ás ${clock(item.startMinute)}, ${durationLabel(item.durationMinutes)}.`,
                  )}
                </span>
              </span>
              <LinkButton
                variant="secondary"
                to={`/municipios/${item.tenantId}/unidades/${item.unitId}/reservar?inicio=${encodeURIComponent(item.slot.start.utc)}&fin=${encodeURIComponent(item.slot.end.utc)}`}
                // The visible text leads the name; the unit tells repeated dates apart.
                aria-label={`${label}, ${item.unitName}`}
              >
                {label}
              </LinkButton>
            </li>
          );
        })}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        loading={turnOff.isPending}
        onClick={() => turnOff.mutate(false)}
      >
        {t("No mostrar recomendaciones", "Non amosar recomendacións")}
      </Button>
      {turnOff.isError && (
        <p role="alert" className={styles.recommendationsNote}>
          {t(
            "No se pudo guardar. Inténtalo de nuevo.",
            "Non se puido gardar. Téntao de novo.",
          )}
        </p>
      )}
    </section>
  );
}
