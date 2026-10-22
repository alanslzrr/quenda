import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type Municipality, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import { Select } from "../../ui/select/select";
import { PageTitle } from "../account/shared";
import {
  detailPath,
  PendingLink,
  type Reservation,
  ReservationSummary,
} from "./shared";
export function ReservationHistory() {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const [tenant, setTenant] = useState("all");
  const municipalities = useInfiniteQuery({
    queryKey: ["public", "municipalities", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Municipality>>(
        `/api/public/municipalities${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const query = useInfiniteQuery({
    queryKey: ["private", account?.accountId, "reservations", tenant, locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (tenant !== "all") params.set("tenantId", tenant);
      if (pageParam) params.set("after", pageParam);
      return api<
        Page<Reservation & { municipality: string; unitName: string }>
      >(`/api/me/reservations?${params}`, { signal }, locale);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <>
      <PageTitle title={t("Mis reservas", "As miñas reservas")} />
      <PendingLink />
      <section className={styles.section}>
        <Select
          label={t("Municipio", "Municipio")}
          value={tenant}
          onValueChange={setTenant}
          options={[
            {
              value: "all",
              label: t("Todos los municipios", "Todos os municipios"),
            },
            ...(municipalities.data?.pages
              .flatMap((p) => p.items)
              .map((m) => ({ value: m.id, label: m.name })) ?? []),
          ]}
        />
        {municipalities.isError && (
          <Failure
            error={municipalities.error}
            retry={() => void municipalities.refetch()}
          />
        )}
        {municipalities.hasNextPage && (
          <Button
            variant="secondary"
            loading={municipalities.isFetchingNextPage}
            onClick={() => void municipalities.fetchNextPage()}
          >
            {t("Cargar más municipios", "Cargar máis municipios")}
          </Button>
        )}
      </section>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className={styles.list}>
            {query.data.pages
              .flatMap((p) => p.items)
              .map((r) => (
                <li key={`${r.tenantId}:${r.id}`} className={styles.listItem}>
                  <Link
                    className={styles.listLink}
                    to={detailPath(r.tenantId, r.id)}
                  >
                    <div>
                      <span className={styles.listTitle}>
                        {r.unitName} · {r.municipality}
                      </span>
                      <ReservationSummary reservation={r} />
                      <span className={styles.listMeta}>
                        {r.status === "CONFIRMADA"
                          ? t("Confirmada", "Confirmada")
                          : r.status === "CANCELADA"
                            ? t("Cancelada", "Cancelada")
                            : t("Finalizada", "Finalizada")}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
          </ul>
          {query.data.pages[0].items.length === 0 && (
            <p>
              {t(
                "No hay reservas en este ámbito.",
                "Non hai reservas neste ámbito.",
              )}
            </p>
          )}
          {query.hasNextPage && (
            <Button
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
  return (
    <>
      <PageTitle title={t("Avisos", "Avisos")}>
        {t(
          "Cambios registrados en tus reservas. Consulta el detalle para ver su estado actual.",
          "Cambios rexistrados nas túas reservas. Consulta o detalle para ver o seu estado actual.",
        )}
      </PageTitle>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className={styles.list}>
            {query.data.pages
              .flatMap((p) => p.items)
              .map((n) => (
                <li key={n.eventId} className={styles.listItem}>
                  <Link
                    className={styles.listLink}
                    to={detailPath(n.tenantId, n.reservationId)}
                  >
                    <div>
                      <span className={styles.listTitle}>
                        {n.kind === "CONFIRMADA"
                          ? t("Reserva confirmada", "Reserva confirmada")
                          : n.kind === "MODIFICADA"
                            ? t("Reserva modificada", "Reserva modificada")
                            : t("Reserva cancelada", "Reserva cancelada")}
                      </span>
                      <ReservationSummary reservation={n} />
                      {n.pendingUsageRulesVersion !== null && (
                        <p>
                          {t(
                            "Este cambio requiere revisar las normas.",
                            "Este cambio require revisar as normas.",
                          )}
                        </p>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
          </ul>
          {query.data.pages[0].items.length === 0 && (
            <p>{t("No hay avisos.", "Non hai avisos.")}</p>
          )}
          {query.hasNextPage && (
            <Button
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
