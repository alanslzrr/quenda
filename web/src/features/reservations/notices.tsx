import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Bell,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { unreadNoticesKey, useUnreadNotices } from "../../app/unread-notices";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { EmptyState } from "../../ui/empty-state/empty-state";
import { browserTimeZone } from "../../ui/lib/intl-cache.ts";
import { PageTitle } from "../account/shared";
import { endsNextDay, intervalLabel } from "../catalog/dates";
import styles from "./notices.module.css";
import { dateTime, detailPath } from "./shared";

interface Notice {
  eventId: string;
  tenantId: string;
  reservationId: string;
  revision: number;
  kind: "CONFIRMADA" | "MODIFICADA" | "CANCELADA";
  occurredAt: string;
  administrative: boolean;
  actorName: string | null;
  reason: string | null;
  municipality: string;
  unitName: string | null;
  facilityName: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  pendingUsageRulesVersion: number | null;
  readAt: string | null;
}
type Group = "today" | "yesterday" | "week" | "earlier";

const day = 86_400_000;
const midnight = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Today, yesterday, the rest of the last seven days, and everything before, in the reader's own calendar. */
export function noticeGroup(occurredAt: string, now = new Date()): Group {
  const days = Math.round(
    (midnight(now) - midnight(new Date(occurredAt))) / day,
  );
  return days <= 0
    ? "today"
    : days === 1
      ? "yesterday"
      : days < 7
        ? "week"
        : "earlier";
}

/** "hace 5 min", "hace 3 h", "ayer", "hace 4 días"; the date once it is a week old. Written here rather than with
 *  Intl.RelativeTimeFormat, which some browsers lack for Galician. */
export function noticeWhen(
  occurredAt: string,
  timeZone: string,
  locale: "es" | "gl",
  now = new Date(),
) {
  const at = new Date(occurredAt);
  const gl = locale === "gl";
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - at.getTime()) / 60_000),
  );
  if (minutes < 1) return gl ? "agora" : "ahora";
  if (minutes < 60) return gl ? `hai ${minutes} min` : `hace ${minutes} min`;
  const days = Math.round((midnight(now) - midnight(at)) / day);
  if (days < 1) {
    const hours = Math.round(minutes / 60);
    return gl ? `hai ${hours} h` : `hace ${hours} h`;
  }
  if (days === 1) return gl ? "onte" : "ayer";
  if (days < 7) return gl ? `hai ${days} días` : `hace ${days} días`;
  return dateTime(occurredAt, timeZone, locale).split(" · ")[0] ?? "";
}

const kindIcon = {
  CONFIRMADA: CalendarCheck2,
  MODIFICADA: CalendarClock,
  CANCELADA: CalendarX2,
} as const;

export function Notices() {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  // When something happened is told in the reader's own time; the booked slot stays in the municipality's.
  const browserZone = browserTimeZone();
  const client = useQueryClient();
  const unread = useUnreadNotices();
  const key = ["private", account?.accountId, "notices", locale];
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<Notice>>(
        `/api/me/notices${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const [marking, setMarking] = useState(false);
  const [problem, setProblem] = useState<unknown>();
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  /** Shows the notices as read at once; the server keeps the first reading time. */
  const markLocally = (match: (notice: Notice) => boolean) => {
    const now = new Date().toISOString();
    client.setQueryData<InfiniteData<Page<Notice>>>(key, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((notice) =>
                !notice.readAt && match(notice)
                  ? { ...notice, readAt: now }
                  : notice,
              ),
            })),
          }
        : data,
    );
  };
  const refreshCount = () =>
    client.invalidateQueries({
      queryKey: unreadNoticesKey(account?.accountId),
    });

  function open(notice: Notice) {
    if (notice.readAt) return;
    markLocally(
      (n) => n.eventId === notice.eventId && n.tenantId === notice.tenantId,
    );
    // The notice opens either way; a failed mark only leaves it unread for next time.
    void api(
      `/api/me/notices/${notice.tenantId}/${notice.eventId}/read`,
      { method: "POST" },
      locale,
    )
      .catch(() => {})
      .finally(() => void refreshCount());
  }
  async function markAll() {
    setProblem(undefined);
    setMarking(true);
    try {
      await api("/api/me/notices/read", { method: "POST" }, locale);
      markLocally(() => true);
      await refreshCount();
    } catch (error) {
      setProblem(error);
    } finally {
      setMarking(false);
    }
  }

  const groupTitle: Record<Group, string> = {
    today: t("Hoy", "Hoxe"),
    yesterday: t("Ayer", "Onte"),
    week: t("Esta semana", "Esta semana"),
    earlier: t("Anteriores", "Anteriores"),
  };
  const kindTitle = (kind: Notice["kind"]) =>
    kind === "CONFIRMADA"
      ? t("Reserva confirmada", "Reserva confirmada")
      : kind === "MODIFICADA"
        ? t("Reserva modificada", "Reserva modificada")
        : t("Reserva cancelada", "Reserva cancelada");
  const groups = (["today", "yesterday", "week", "earlier"] as const)
    .map((group) => ({
      group,
      notices: items.filter((n) => noticeGroup(n.occurredAt) === group),
    }))
    .filter((entry) => entry.notices.length > 0);
  const anyUnread = unread > 0 || items.some((n) => !n.readAt);

  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <PageTitle title={t("Avisos", "Avisos")}>
          {t(
            "Cambios en tus reservas. Abre un aviso para ver cómo está ahora la reserva.",
            "Cambios nas túas reservas. Abre un aviso para ver como está agora a reserva.",
          )}
        </PageTitle>
        {anyUnread && (
          <Button
            variant="secondary"
            size="sm"
            loading={marking}
            onClick={() => void markAll()}
          >
            {t("Marcar todo como leído", "Marcar todo como lido")}
          </Button>
        )}
      </div>
      {problem !== undefined && <Failure error={problem} />}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={<Bell width={24} height={24} strokeWidth={1.5} />}
          title={t("No tienes avisos", "Non tes avisos")}
          description={t(
            "Cuando se confirme, cambie o cancele una reserva tuya, lo verás aquí.",
            "Cando se confirme, cambie ou cancele unha reserva túa, veralo aquí.",
          )}
          headingLevel={2}
        />
      ) : (
        <>
          {groups.map(({ group, notices }) => (
            <section
              key={group}
              className={styles.group}
              aria-labelledby={`notices-${group}`}
            >
              <h2 id={`notices-${group}`} className={styles.groupTitle}>
                {groupTitle[group]}
              </h2>
              <ul className={styles.list}>
                {notices.map((n) => {
                  const Icon = kindIcon[n.kind];
                  const place = [n.facilityName, n.municipality]
                    .filter(Boolean)
                    .join(" · ");
                  const fresh = !n.readAt;
                  return (
                    <li key={`${n.tenantId}:${n.eventId}`}>
                      <Link
                        className={styles.notice}
                        data-unread={fresh || undefined}
                        to={detailPath(n.tenantId, n.reservationId)}
                        onClick={() => open(n)}
                      >
                        <span
                          className={styles.kind}
                          data-kind={n.kind}
                          aria-hidden="true"
                        >
                          <Icon size={18} strokeWidth={1.75} />
                        </span>
                        <span className={styles.body}>
                          <span className={styles.head}>
                            <span className={styles.title}>
                              {fresh && (
                                <span className={styles.hidden}>
                                  {t("Sin leer: ", "Sen ler: ")}
                                </span>
                              )}
                              {kindTitle(n.kind)}
                              {n.unitName && (
                                <span className={styles.unit}>
                                  {" · "}
                                  {n.unitName}
                                </span>
                              )}
                            </span>
                            <time
                              className={styles.when}
                              dateTime={n.occurredAt}
                              title={dateTime(
                                n.occurredAt,
                                browserZone,
                                locale,
                              )}
                            >
                              {noticeWhen(n.occurredAt, browserZone, locale)}
                            </time>
                          </span>
                          {place && (
                            <span className={styles.meta}>{place}</span>
                          )}
                          <span className={styles.slot}>
                            <CalendarDays size={14} aria-hidden="true" />
                            {intervalLabel(
                              n.startsAt,
                              n.endsAt,
                              n.timeZone,
                              locale,
                            )}
                            {endsNextDay(n.startsAt, n.endsAt, n.timeZone) &&
                              ` (${t("termina al día siguiente", "remata ao día seguinte")})`}
                          </span>
                          {n.administrative && (
                            <span className={styles.callout}>
                              <ShieldAlert size={14} aria-hidden="true" />
                              <span>
                                <strong>
                                  {t(
                                    "Cambio hecho por la administración",
                                    "Cambio feito pola administración",
                                  )}
                                </strong>
                                {" · "}
                                {n.actorName ??
                                  t(
                                    "nombre no registrado",
                                    "nome non rexistrado",
                                  )}
                                {n.reason && (
                                  <>
                                    <br />
                                    {t("Motivo", "Motivo")}: {n.reason}
                                  </>
                                )}
                              </span>
                            </span>
                          )}
                          {n.pendingUsageRulesVersion !== null && (
                            <span>
                              <Badge size="sm" tone="warning">
                                {t(
                                  "Tienes que revisar las normas",
                                  "Tes que revisar as normas",
                                )}
                              </Badge>
                            </span>
                          )}
                        </span>
                        {fresh && (
                          <span className={styles.dot} aria-hidden="true" />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
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
    </div>
  );
}
