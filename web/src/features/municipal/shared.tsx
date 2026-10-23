import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router";
import { ActionForm } from "../../app/action";
import { ApiError, api, type Navigation, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import layout from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import { allowed, canEnter } from "../reporting/model";
import styles from "./municipal.module.css";

export type MunicipalContext = Navigation["municipalities"]["items"][number];
export function permitted(
  context: MunicipalContext,
  operation: string,
  unitId: string | null = null,
) {
  return (
    context.administrator ||
    context.permissions.some(
      (p) =>
        p.operation === operation && (p.unitId === null || p.unitId === unitId),
    )
  );
}
const Context = createContext<MunicipalContext | null>(null);
export function useMunicipality() {
  const context = useContext(Context);
  if (!context) throw new Error("Missing municipal context");
  return context;
}
export const municipalPath = (id: string) => `/administracion/${id}`;
export const endpoint = (id: string) => `/api/municipalities/${id}`;
export function useMunicipalQuery<T>(path: string, optional = false) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useQuery({
    queryKey: ["private", account?.accountId, "municipal", path, locale],
    queryFn: async ({ signal }) => {
      try {
        return await api<T>(path, { signal }, locale);
      } catch (error) {
        if (optional && error instanceof ApiError && error.status === 404)
          return null;
        throw error;
      }
    },
    enabled: !!account,
    retry: false,
  });
}
export function useMunicipalPages<T>(path: string) {
  const { account } = useSession();
  const { locale } = usePreferences();
  return useInfiniteQuery({
    queryKey: ["private", account?.accountId, "municipal", path, locale],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api<Page<T>>(
        `${path}${path.includes("?") ? "&" : "?"}after=${pageParam}`.replace(
          /([?&])after=$/,
          "",
        ),
        { signal },
        locale,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!account,
    retry: false,
  });
}
export function More({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
  };
}) {
  const { t } = usePreferences();
  return query.hasNextPage ? (
    <Button
      variant="secondary"
      loading={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {t("Cargar más", "Cargar máis")}
    </Button>
  ) : null;
}
export function Administration() {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: ["private", account?.accountId, "navigation", locale],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api<Navigation>(
        `/api/me/navigation${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (last) => last.municipalities.nextCursor ?? undefined,
  });
  return (
    <>
      <h1>{t("Administración municipal", "Administración municipal")}</h1>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} />
      ) : (
        <>
          {query.data.pages[0]?.platform.operator && (
            <p>
              <Link to="/plataforma">
                {t(
                  "Administración de plataforma",
                  "Administración de plataforma",
                )}
              </Link>
            </p>
          )}
          {query.data.pages[0]?.platform.permissions.some((p) =>
            ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p),
          ) && (
            <Link to="/plataforma/privacidad">
              {t(
                "Conservación y derechos globales",
                "Conservación e dereitos globais",
              )}
            </Link>
          )}
          <ul className={layout.list}>
            {query.data.pages
              .flatMap((p) => p.municipalities.items)
              .map((m) => (
                <li key={m.id} className={layout.listItem}>
                  <Link className={layout.listLink} to={municipalPath(m.id)}>
                    {m.name}
                  </Link>
                </li>
              ))}
          </ul>
          {!query.data.pages[0]?.municipalities.items.length && (
            <p>
              {t(
                "No tienes permisos municipales vigentes.",
                "Non tes permisos municipais vixentes.",
              )}
            </p>
          )}
          <More query={query} />
        </>
      )}
    </>
  );
}
export function MunicipalLayout() {
  useMunicipalTheme(undefined);
  const { tenantId = "" } = useParams();
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const query = useQuery({
    queryKey: [
      "private",
      account?.accountId,
      "municipal-context",
      tenantId,
      locale,
    ],
    retry: false,
    queryFn: async ({ signal }) => {
      let after: string | null = null;
      do {
        const result: Navigation = await api(
          `/api/me/navigation${after ? `?after=${after}` : ""}`,
          { signal },
          locale,
        );
        const found = result.municipalities.items.find(
          (m) => m.id === tenantId,
        );
        if (found) return found;
        after = result.municipalities.nextCursor;
      } while (after);
      throw new ApiError(
        403,
        "FORBIDDEN",
        t(
          "No tienes acceso a este municipio.",
          "Non tes acceso a este municipio.",
        ),
      );
    },
  });
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const context = query.data;
  const has = (...ops: string[]) =>
    context.administrator ||
    context.permissions.some((p) => ops.includes(p.operation));
  return (
    <Context.Provider value={context}>
      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <Link to="/administracion">{t("Municipios", "Municipios")}</Link>
          <h2>{context.name}</h2>
          <nav aria-label={t("Gestión municipal", "Xestión municipal")}>
            {has("CATALOG_CREATE", "CATALOG_MANAGE") && (
              <NavLink end to={municipalPath(tenantId)}>
                {t("Instalaciones y unidades", "Instalacións e unidades")}
              </NavLink>
            )}
            {has("RESERVATION_READ", "RESERVATION_MANAGE", "UNIT_BLOCK") && (
              <NavLink to={`${municipalPath(tenantId)}/agenda`}>
                {t("Agenda diaria", "Axenda diaria")}
              </NavLink>
            )}
            {canEnter(context) && (
              <NavLink to={`${municipalPath(tenantId)}/indicadores`}>
                {t("Indicadores", "Indicadores")}
              </NavLink>
            )}
            {canEnter(context, true) && (
              <NavLink to={`${municipalPath(tenantId)}/exportaciones`}>
                {t("Exportar reservas", "Exportar reservas")}
              </NavLink>
            )}
            {allowed(context, "REPORT_READ", null) && (
              <NavLink end to={`${municipalPath(tenantId)}/informes`}>
                {t("Informes conjuntos", "Informes conxuntos")}
              </NavLink>
            )}
            {context.administrator && (
              <NavLink to={`${municipalPath(tenantId)}/informes/revision`}>
                {t("Revisar informes", "Revisar informes")}
              </NavLink>
            )}
            {context.permissions.some(
              (p) =>
                p.unitId === null &&
                ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p.operation),
            ) && (
              <NavLink to={`${municipalPath(tenantId)}/privacidad`}>
                {t("Conservación y derechos", "Conservación e dereitos")}
              </NavLink>
            )}
            {context.administrator && (
              <>
                <NavLink to={`${municipalPath(tenantId)}/convenios`}>
                  {t("Convenios", "Convenios")}
                </NavLink>
                <NavLink to={`${municipalPath(tenantId)}/acreditaciones`}>
                  {t("Acreditaciones", "Acreditacións")}
                </NavLink>
                <NavLink to={`${municipalPath(tenantId)}/personal`}>
                  {t("Personal y permisos", "Persoal e permisos")}
                </NavLink>
                <NavLink to={`${municipalPath(tenantId)}/condiciones`}>
                  {t("Condiciones de reserva", "Condicións de reserva")}
                </NavLink>
                <NavLink to={`${municipalPath(tenantId)}/apariencia`}>
                  {t("Apariencia", "Aparencia")}
                </NavLink>
              </>
            )}
          </nav>
          <Link to="/perfil/seguridad" target="_blank" rel="noopener">
            {t("Verificar MFA (nueva pestaña)", "Verificar MFA (nova pestana)")}
          </Link>
          <p>
            {t(
              "Las operaciones sensibles requieren MFA verificado en los últimos cinco minutos.",
              "As operacións sensibles requiren MFA verificado nos últimos cinco minutos.",
            )}
          </p>
        </aside>
        <div
          className={styles.content}
          key={`${account?.accountId}:${tenantId}`}
        >
          <Outlet />
        </div>
      </div>
    </Context.Provider>
  );
}
export function Denied() {
  const { t } = usePreferences();
  return (
    <p role="alert">
      {t(
        "No tienes permiso para esta operación.",
        "Non tes permiso para esta operación.",
      )}
    </p>
  );
}
export function Reason() {
  const { t } = usePreferences();
  return (
    <Input
      label={t("Motivo", "Motivo")}
      name="reason"
      required
      maxLength={500}
    />
  );
}
// No automatic mutation retries. Unknown outcomes require reading current state.
export function MunicipalForm({
  path,
  method = "POST",
  body,
  label,
  children,
  onSaved,
  resetOnSuccess = false,
  danger = false,
}: {
  path: string;
  method?: string;
  body: (data: FormData) => unknown;
  label: string;
  children?: ReactNode;
  onSaved?: (result: unknown) => void | Promise<void>;
  danger?: boolean;
  resetOnSuccess?: boolean;
}) {
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  const { account } = useSession();
  const [uncertain, setUncertain] = useState(false);
  return (
    <>
      <ActionForm
        danger={danger}
        disabled={uncertain}
        resetOnSuccess={resetOnSuccess}
        label={label}
        success={t("Cambios guardados.", "Cambios gardados.")}
        submit={async (data) => {
          let result: unknown;
          try {
            result = await api(
              path,
              { method, body: JSON.stringify(body(data)) },
              locale,
            );
          } catch (error) {
            if (!(error instanceof ApiError) || error.status >= 500) {
              setUncertain(true);
              throw new ApiError(
                0,
                "UNCERTAIN_RESULT",
                t(
                  "No se recibió confirmación. Consulta el estado actual antes de repetir la operación.",
                  "Non se recibiu confirmación. Consulta o estado actual antes de repetir a operación.",
                ),
              );
            }
            throw error;
          }
          await client.invalidateQueries({
            queryKey: ["private", account?.accountId, "municipal"],
          });
          await client.invalidateQueries({ queryKey: ["public"] });
          await onSaved?.(result);
        }}
      >
        {children}
      </ActionForm>
      {uncertain && (
        <Button variant="secondary" onClick={() => setUncertain(false)}>
          {t(
            "He comprobado el resultado; permitir otra solicitud",
            "Comprobei o resultado; permitir outra solicitude",
          )}
        </Button>
      )}
    </>
  );
}
