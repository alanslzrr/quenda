import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarDays, CalendarPlus } from "lucide-react";
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
import { EmptyState } from "../../ui/empty-state/empty-state";
import { compareText } from "../../ui/lib/intl-cache.ts";
import { Select } from "../../ui/select/select";
import { PageTitle } from "../account/shared";
import { endsNextDay, intervalLabel } from "../catalog/dates";
import { useBookingEntry } from "../catalog/journey";
import { HabitualSlots } from "./recommendations";
import styles from "./reservations.module.css";
import { detailPath, PendingLink, type Reservation } from "./shared";
import { CalendarActions } from "./subscription";

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
    .sort((a, b) => compareText(a[1], b[1], locale));
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
        {/* Starting a booking lives in the tabs above; this slot takes reservations to a calendar. */}
        <CalendarActions download={!!items.length} />
      </div>
      <PendingLink />
      <HabitualSlots />
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
        <EmptyState
          icon={<CalendarDays width={24} height={24} strokeWidth={1.5} />}
          title={t("Todavía no tienes reservas", "Aínda non tes reservas")}
          description={
            tenant === "all"
              ? t(
                  "Elige municipio, instalación, espacio y hora. La reserva aparecerá aquí.",
                  "Escolle municipio, instalación, espazo e hora. A reserva aparecerá aquí.",
                )
              : t(
                  "No tienes reservas en este municipio.",
                  "Non tes reservas neste municipio.",
                )
          }
          action={newBooking}
          headingLevel={2}
        />
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
