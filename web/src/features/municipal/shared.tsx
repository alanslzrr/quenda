import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Outlet, useParams } from "react-router";
import { ActionForm } from "../../app/action";
import { ApiError, api, type Navigation, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { ActionLink } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { canRefetch } from "../../app/query";
import {
  discardEditor,
  EditorRecovery,
  useReadBlocked,
} from "../../app/read-recovery";
import { useSession } from "../../app/session";
import { browserStorage } from "../../app/storage.ts";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import booking from "../catalog/booking.module.css";
import { Choice, Choices } from "../catalog/journey";
import { IdempotentAction } from "../reservations/idempotent-action";
import { municipalityLabel } from "./municipality-label.ts";
import { ResourceShell } from "./resource-shell";

export { discardEditor, EditorRecovery } from "../../app/read-recovery";

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
export function useMunicipalQuery<T>(
  path: string,
  optional = false,
  refetchOnMount = true,
) {
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
    refetchOnMount: (query) => refetchOnMount && canRefetch(query.state.error),
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
        `${path}${path.includes("?") ? "&" : "?"}after=${encodeURIComponent(pageParam)}`.replace(
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
    isFetching: boolean;
    fetchNextPage: () => unknown;
  };
}) {
  const { t } = usePreferences();
  return query.hasNextPage ? (
    <Button
      type="button"
      variant="secondary"
      loading={query.isFetchingNextPage}
      disabled={query.isFetching}
      onClick={() => {
        if (!query.isFetching) void query.fetchNextPage();
      }}
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
        `/api/me/navigation${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (last) => last.municipalities.nextCursor ?? undefined,
  });
  const platform = query.data?.pages[0]?.platform;
  const privacy = platform?.permissions.some((p) =>
    ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p),
  );
  const municipalities =
    query.data?.pages.flatMap((p) => p.municipalities.items) ?? [];
  const labelOf = (m: (typeof municipalities)[number]) =>
    municipalityLabel(m, municipalities);
  return (
    <div className={booking.page}>
      <header className={booking.intro}>
        <h1 className={booking.title}>
          {t("Gestión municipal", "Xestión municipal")}
        </h1>
        <p className={booking.lead}>
          {t(
            "Aquí actúas como personal autorizado, con los permisos que te han concedido. Para reservar a tu nombre usa «Reservar».",
            "Aquí actúas como persoal autorizado, cos permisos que che concederon. Para reservar ao teu nome usa «Reservar».",
          )}
        </p>
      </header>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className={booking.sections}>
          <section aria-labelledby="managed-heading">
            <h2 id="managed-heading" className={booking.sectionTitle}>
              {t("Municipios que gestionas", "Municipios que xestionas")}
            </h2>
            {municipalities.length ? (
              <Choices>
                {municipalities.map((m) => (
                  <Choice
                    key={m.id}
                    to={municipalPath(m.id)}
                    title={labelOf(m)}
                    meta={
                      m.administrator
                        ? t(
                            "Administración del municipio",
                            "Administración do municipio",
                          )
                        : t(
                            `${m.permissions.length} ${m.permissions.length === 1 ? "permiso delegado" : "permisos delegados"}`,
                            `${m.permissions.length} ${m.permissions.length === 1 ? "permiso delegado" : "permisos delegados"}`,
                          )
                    }
                  />
                ))}
              </Choices>
            ) : (
              <p className={booking.quiet}>
                {t(
                  "No tienes permisos municipales vigentes.",
                  "Non tes permisos municipais vixentes.",
                )}
              </p>
            )}
            <More query={query} />
          </section>
          {(platform?.operator || privacy) && (
            <section aria-labelledby="platform-heading">
              <h2 id="platform-heading" className={booking.sectionTitle}>
                {t("Plataforma", "Plataforma")}
              </h2>
              <Choices>
                {platform?.operator && (
                  <Choice
                    to="/plataforma"
                    title={t(
                      "Administración de plataforma",
                      "Administración de plataforma",
                    )}
                  />
                )}
                {privacy && (
                  <Choice
                    to="/plataforma/privacidad"
                    title={t(
                      "Conservación y derechos globales",
                      "Conservación e dereitos globais",
                    )}
                  />
                )}
              </Choices>
            </section>
          )}
        </div>
      )}
    </div>
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
      let found: Navigation["municipalities"]["items"][number] | undefined;
      const seen: { id: string; name: string }[] = [];
      // Keep reading the (small) list after the match so homonyms on later pages are noticed.
      for (let page = 0; page < 10; page += 1) {
        const result: Navigation = await api(
          `/api/me/navigation${after ? `?after=${encodeURIComponent(after)}` : ""}`,
          { signal },
          locale,
        );
        seen.push(...result.municipalities.items);
        found ??= result.municipalities.items.find((m) => m.id === tenantId);
        after = result.municipalities.nextCursor;
        if (!after) break;
      }
      if (found) return { ...found, name: municipalityLabel(found, seen) };
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
  if (query.isError && (!query.data || discardEditor(query.error)))
    return (
      <>
        <Failure error={query.error} retry={() => void query.refetch()} />
        {/* The management shell is not drawn here, so offer the way out. */}
        <ActionLink to="/administracion">
          {t("Volver a Gestión", "Volver a Xestión")}
        </ActionLink>
      </>
    );
  const context = query.data;
  if (!context) return null;
  return (
    <Context.Provider value={context}>
      <ResourceShell municipality={context}>
        <EditorRecovery error={query.error} retry={() => void query.refetch()}>
          <Outlet key={`${account?.accountId}:${tenantId}`} />
        </EditorRecovery>
      </ResourceShell>
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
      pattern={String.raw`.*\S.*`}
      title={t(
        "Indica un motivo; no puede quedar en blanco.",
        "Indica un motivo; non pode quedar en branco.",
      )}
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
  // The marker (never the request) survives navigation and reload, because these endpoints have no replay contract.
  const marker = `quenda.municipal-uncertain:${account?.accountId ?? ""}:${method}:${path}`;
  const [uncertain, setUncertainState] = useState(() => {
    try {
      // Blocked site storage holds no marker: it must not lock the form.
      return (browserStorage("session")?.getItem(marker) ?? null) !== null;
    } catch {
      return false;
    }
  });
  const setUncertain = (value: boolean) => {
    setUncertainState(value);
    try {
      const storage = browserStorage("session");
      if (value) storage?.setItem(marker, "pending");
      else storage?.removeItem(marker);
    } catch {
      /* Without storage the guard still holds while this view stays mounted. */
    }
  };
  const readBlocked = useReadBlocked();
  if (
    method === "POST" &&
    /^\/api\/municipalities\/[\da-f-]+\/facilities(?:\/[\da-f-]+\/units)?$/.test(
      path,
    )
  )
    return (
      <IdempotentAction
        path={path}
        body={body}
        label={label}
        onResult={onSaved}
        danger={danger}
        disabled={readBlocked}
        resetOnSuccess={resetOnSuccess}
      >
        {children}
      </IdempotentAction>
    );
  return (
    <>
      <ActionForm
        danger={danger}
        disabled={uncertain || readBlocked}
        resetOnSuccess={resetOnSuccess}
        clearOnSuccess={["reason"]}
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
