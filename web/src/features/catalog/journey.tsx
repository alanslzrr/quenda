import { useInfiniteQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { announce } from "../../app/announce";
import { api, type Municipality, type Page } from "../../app/api";
import { useFavorite } from "../../app/favorite";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { Stepper } from "../../ui/stepper/stepper";
import styles from "./booking.module.css";

export const pickerPath = "/reservar";
export const municipalityPath = (tenantId: string, query = "") =>
  `/municipios/${tenantId}${query}`;
export const facilityPath = (
  tenantId: string,
  facilityId: string,
  query = "",
) => `/municipios/${tenantId}/instalaciones/${facilityId}${query}`;
export const unitPath = (tenantId: string, unitId: string, query = "") =>
  `/municipios/${tenantId}/unidades/${unitId}${query}`;
export const searchPath = (tenantId: string, query = "") =>
  `/municipios/${tenantId}/horarios${query}`;

/** Carry preferences, never a selected slot or resource, while editing the current journey. */
export function useJourneyQuery() {
  const [search] = useSearchParams();
  const kept = new URLSearchParams();
  for (const key of ["fecha", "duracion"]) {
    const value = search.get(key);
    if (value) kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

/** A fresh booking starts without the previous journey's date, duration, resource or slot. */
export function useBookingEntry() {
  const [favorite] = useFavorite();
  return favorite ? municipalityPath(favorite) : pickerPath;
}

export function useMunicipalities() {
  const { locale } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: ["public", "municipalities", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Municipality>>(
        `/api/public/municipalities${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
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

export type JourneyStep = 0 | 1 | 2 | 3 | 4;

/**
 * Municipality, facility, unit, time and review. Every completed step names what was chosen and leads back to it;
 * the date and duration travel along so going back never loses them.
 */
export function BookingSteps({
  current,
  tenantId,
  municipality,
  facility,
  unit,
  slot,
  query = "",
}: {
  current: JourneyStep;
  tenantId?: string;
  municipality?: string;
  facility?: { id: string; name: string };
  unit?: { id: string; name: string };
  slot?: string;
  query?: string;
}) {
  const { t } = usePreferences();
  const navigate = useNavigate();
  const stepNames = [
    t("Municipio", "Municipio"),
    t("Instalación", "Instalación"),
    t("Espacio", "Espazo"),
    t("Día y hora", "Día e hora"),
    t("Revisar y confirmar", "Revisar e confirmar"),
  ];
  const position = t(
    `Paso ${current + 1} de ${stepNames.length}: ${stepNames[current]}`,
    `Paso ${current + 1} de ${stepNames.length}: ${stepNames[current]}`,
  );
  // The stepper remounts with every page, so its own live region never sees a change; announce through the persistent one.
  useEffect(() => {
    announce(position);
  }, [position]);
  const paths = [
    `${pickerPath}${query}`,
    tenantId ? municipalityPath(tenantId, query) : undefined,
    tenantId && facility
      ? facilityPath(tenantId, facility.id, query)
      : undefined,
    tenantId && unit ? unitPath(tenantId, unit.id, query) : undefined,
  ];
  return (
    <Stepper
      className={styles.steps}
      current={current}
      label={t("Pasos de la reserva", "Pasos da reserva")}
      completeLabel={t("Reserva lista", "Reserva lista")}
      labels={{
        complete: t("completado", "completado"),
        upcoming: t("pendiente", "pendente"),
        error: t("con un problema", "cun problema"),
        position: (step, total, label) =>
          t(
            `Paso ${step} de ${total}: ${label}`,
            `Paso ${step} de ${total}: ${label}`,
          ),
      }}
      onStepSelect={(index) => {
        const path = paths[index];
        if (path) navigate(path);
      }}
      steps={[
        {
          id: "municipality",
          label: t("Municipio", "Municipio"),
          description: municipality,
        },
        {
          id: "facility",
          label: t("Instalación", "Instalación"),
          description: facility?.name,
        },
        {
          id: "unit",
          label: t("Espacio", "Espazo"),
          description: unit?.name,
        },
        {
          id: "time",
          label: t("Día y hora", "Día e hora"),
          description: slot,
        },
        {
          id: "review",
          label: t("Revisar y confirmar", "Revisar e confirmar"),
        },
      ]}
    />
  );
}

export function Choices({ children }: { children: ReactNode }) {
  return <ul className={styles.choices}>{children}</ul>;
}

/** A choice is the whole row; unavailable ones stay listed with the reason in words. */
export function Choice({
  to,
  title,
  meta,
  badge,
  aside,
  media,
}: {
  to?: string;
  title: string;
  meta?: ReactNode;
  badge?: ReactNode;
  aside?: ReactNode;
  /** A cover photo or its placeholder, before the text. */
  media?: ReactNode;
}) {
  const body = (
    <>
      {media}
      <span className={styles.choiceText}>
        <span className={styles.choiceTitle}>
          {title}
          {badge}
        </span>
        {meta && <span className={styles.choiceMeta}>{meta}</span>}
      </span>
    </>
  );
  return (
    <li className={styles.choice} data-off={!to || undefined}>
      {to ? (
        <Link className={styles.choiceLink} to={to}>
          {body}
        </Link>
      ) : (
        <div className={styles.choiceLink}>{body}</div>
      )}
      {aside}
    </li>
  );
}

export function FavoriteBadge() {
  const { t } = usePreferences();
  return (
    <Badge size="sm" tone="info">
      {t("Favorito", "Favorito")}
    </Badge>
  );
}

export function FavoriteToggle({
  tenantId,
  name,
  compact = false,
}: {
  tenantId: string;
  name: string;
  compact?: boolean;
}) {
  const { t } = usePreferences();
  const [favorite, setFavorite] = useFavorite();
  const on = favorite === tenantId;
  const text = on
    ? t("Quitar de favoritos", "Quitar dos favoritos")
    : t("Marcar como favorito", "Marcar como favorito");
  const label = on
    ? t(`Quitar ${name} de favoritos`, `Quitar ${name} de favoritos`)
    : t(`Marcar ${name} como favorito`, `Marcar ${name} como favorito`);
  return (
    <Button
      type="button"
      size="sm"
      variant={compact ? "ghost" : "secondary"}
      className={styles.favorite}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      data-on={on || undefined}
      data-favorite={tenantId}
      onClick={() => {
        setFavorite(on ? null : tenantId);
        // The row may move between lists; keep keyboard focus on the same toggle.
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-favorite="${tenantId}"]`)
            ?.focus(),
        );
      }}
    >
      <Star size={16} aria-hidden="true" fill={on ? "currentColor" : "none"} />
      {!compact && text}
    </Button>
  );
}
