import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import { PageTitle } from "../account/shared";
import { endsNextDay, intervalLabel } from "../catalog/dates";
import { useBookingEntry } from "../catalog/journey";
import styles from "./reservations.module.css";
import { detailPath, PendingLink, type Reservation } from "./shared";

type HistoryItem = Reservation & { municipality: string; unitName: string };

function useHistory(tenant: string) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useInfiniteQuery({
    queryKey: ["private", account?.accountId, "reservations", tenant, locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (tenant !== "all") params.set("tenantId", tenant);
      if (pageParam) params.set("after", pageParam);
      return api<Page<HistoryItem>>(
        `/api/me/reservations?${params}`,
        { signal },
        locale,
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

// The filter lists the municipalities where this account has bookings, whichever history page is loaded.
function useHistoryMunicipalities() {
  const { account } = useSession();
  const { locale } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: [
      "private",
      account?.accountId,
      "reservation-municipalities",
      locale,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ tenantId: string; name: string }>>(
        `/api/me/reservations/municipalities${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  const loaded = query.data?.pages.length ?? 0;
  useEffect(() => {
    // The list is the account's own footprint and small; stop on error or after a safety cap.
    if (hasNextPage && !isFetching && !isError && loaded < 10)
      void fetchNextPage();
  }, [hasNextPage, isFetching, isError, loaded, fetchNextPage]);
  return query;
}

export function ReservationHistory() {
  useMunicipalTheme(undefined);
  const { locale, t } = usePreferences();
  const [tenant, setTenant] = useState("all");
  const entry = useBookingEntry();
  const query = useHistory(tenant);
  const footprint = useHistoryMunicipalities();
  const known = footprint.data?.pages.flatMap((page) => page.items) ?? [];
  const municipalities: [string, string][] = known
    .map((m): [string, string] => [
      m.tenantId,
      // Names are not unique: a repeated name carries the end of its id.
      known.filter((other) => other.name === m.name).length > 1
        ? `${m.name} · ${m.tenantId.slice(-6)}`
        : m.name,
    ])
    .sort((a, b) => a[1].localeCompare(b[1], locale));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const status = (value: Reservation["status"]) =>
    value === "CONFIRMADA"
      ? t("Confirmada", "Confirmada")
      : value === "CANCELADA"
        ? t("Cancelada", "Cancelada")
        : t("Finalizada", "Finalizada");
  const newBooking = (
    <LinkButton to={entry} variant="primary">
      <CalendarPlus size={16} aria-hidden="true" />
      {t("Nueva reserva", "Nova reserva")}
    </LinkButton>
  );
  return (
    <>
      <div className={styles.heading}>
        <PageTitle title={t("Mis reservas", "As miñas reservas")} />
        {!!items.length && newBooking}
      </div>
      <PendingLink />
      {!!items.length && (
        <p>
          <a href={`/api/me/reservations/calendar.ics?lang=${locale}`} download>
            {t(
              "Descargar mis próximas reservas (.ics)",
              "Descargar as miñas próximas reservas (.ics)",
            )}
          </a>
        </p>
      )}
      {municipalities.length > 1 && (
        <div className={styles.toolbar}>
          <Select
            label={t("Municipio", "Municipio")}
            value={tenant}
            onValueChange={setTenant}
            options={[
              {
                value: "all",
                label: t("Todos los municipios", "Todos os municipios"),
              },
              ...municipalities.map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <div className={styles.empty}>
          <p>{t("Todavía no tienes reservas.", "Aínda non tes reservas.")}</p>
          <span>
            {tenant === "all"
              ? t(
                  "Elige municipio, instalación, espacio y hora. La reserva aparecerá aquí.",
                  "Escolle municipio, instalación, espazo e hora. A reserva aparecerá aquí.",
                )
              : t(
                  "No tienes reservas en este municipio.",
                  "Non tes reservas neste municipio.",
                )}
          </span>
          <div className={styles.actions}>{newBooking}</div>
        </div>
      ) : (
        <>
          <ul className={styles.rows}>
            {items.map((r) => (
              <li key={`${r.tenantId}:${r.id}`}>
                <Link className={styles.row} to={detailPath(r.tenantId, r.id)}>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>{r.unitName}</span>
                    <span className={styles.rowMeta}>
                      {r.municipality} ·{" "}
                      {intervalLabel(r.startsAt, r.endsAt, r.timeZone, locale)}
                      {endsNextDay(r.startsAt, r.endsAt, r.timeZone) &&
                        ` (${t("termina al día siguiente", "remata ao día seguinte")})`}
                    </span>
                  </span>
                  <Badge
                    size="sm"
                    tone={r.status === "CONFIRMADA" ? "success" : "neutral"}
                  >
                    {status(r.status)}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <Button
              className={styles.more}
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("Ver más reservas", "Ver máis reservas")}
            </Button>
          )}
        </>
      )}
    </>
  );
}

interface Notice {
  eventId: string;
  tenantId: string;
  reservationId: string;
  revision: number;
  kind: "CONFIRMADA" | "MODIFICADA" | "CANCELADA";
  occurredAt: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  pendingUsageRulesVersion: number | null;
}
export function Notices() {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: ["private", account?.accountId, "notices", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Notice>>(
        `/api/me/notices${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageTitle title={t("Avisos", "Avisos")}>
        {t(
          "Cambios en tus reservas. Abre cada aviso para ver el estado actual.",
          "Cambios nas túas reservas. Abre cada aviso para ver o estado actual.",
        )}
      </PageTitle>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <div className={styles.empty}>
          <p>{t("No tienes avisos.", "Non tes avisos.")}</p>
        </div>
      ) : (
        <>
          <ul className={styles.rows}>
            {items.map((n) => (
              <li key={n.eventId}>
                <Link
                  className={styles.row}
                  to={detailPath(n.tenantId, n.reservationId)}
                >
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>
                      {n.kind === "CONFIRMADA"
                        ? t("Reserva confirmada", "Reserva confirmada")
                        : n.kind === "MODIFICADA"
                          ? t("Reserva modificada", "Reserva modificada")
                          : t("Reserva cancelada", "Reserva cancelada")}
                    </span>
                    <span className={styles.rowMeta}>
                      {intervalLabel(n.startsAt, n.endsAt, n.timeZone, locale)}
                    </span>
                  </span>
                  {n.pendingUsageRulesVersion !== null ? (
                    <Badge size="sm" tone="warning">
                      {t("Revisar normas", "Revisar normas")}
                    </Badge>
                  ) : (
                    <span />
                  )}
                </Link>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <Button
              className={styles.more}
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("Ver más avisos", "Ver máis avisos")}
            </Button>
          )}
        </>
      )}
    </>
  );
}
