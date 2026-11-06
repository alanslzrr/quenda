import { Archive, Clock3, FileText, Globe, Settings2 } from "lucide-react";
import { useState } from "react";
import { Navigate, useParams } from "react-router";
import { textField } from "../../app/action";
import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Badge } from "../../ui/badge/badge";
import { PageHeader } from "../../ui/blocks/page-header/page-header";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Dialog, DialogContent, DialogTrigger } from "../../ui/dialog/dialog";
import { Input } from "../../ui/input/input";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs/tabs";
import { CalendarEditor, RulesEditor } from "./configuration";
import { landingSection } from "./landing.ts";
import styles from "./municipal.module.css";
import resourceStyles from "./resource.module.css";
import {
  Denied,
  discardEditor,
  EditorRecovery,
  endpoint,
  More,
  MunicipalForm,
  municipalPath,
  permitted,
  Reason,
  useMunicipality,
  useMunicipalPages,
  useMunicipalQuery,
} from "./shared";

export type Resource = {
  id: string;
  name: string;
  facilityId: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
};
export function Catalog() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const hasCatalog =
    m.administrator ||
    m.permissions.some((p) => p.operation.startsWith("CATALOG_"));
  if (!hasCatalog) {
    const landing = landingSection(m);
    if (landing !== null)
      return <Navigate replace to={`${municipalPath(m.id)}${landing}`} />;
    return (
      <>
        <h1>{t("Sin secciones de gestión", "Sen seccións de xestión")}</h1>
        <p>
          {t(
            "Tus permisos en este municipio no abren ninguna sección de gestión.",
            "Os teus permisos neste municipio non abren ningunha sección de xestión.",
          )}
        </p>
        <Link to="/administracion">
          {t("Volver a Gestión", "Volver a Xestión")}
        </Link>
      </>
    );
  }
  return (
    <>
      <h1>{t("Instalaciones y unidades", "Instalacións e unidades")}</h1>
      <ResourceList kind="facilities" />
      <ResourceList kind="units" />
      {permitted(m, "CATALOG_CREATE") && (
        <section className={styles.section}>
          <h2>{t("Nueva instalación", "Nova instalación")}</h2>
          <MunicipalForm
            path={`${endpoint(m.id)}/facilities`}
            resetOnSuccess
            label={t("Crear instalación", "Crear instalación")}
            body={(d) => ({ name: textField(d, "name").trim() })}
          >
            <Input
              name="name"
              label={t("Nombre", "Nome")}
              required
              maxLength={200}
            />
          </MunicipalForm>
        </section>
      )}
    </>
  );
}
function ResourceList({ kind }: { kind: "facilities" | "units" }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const query = useMunicipalPages<Resource>(`${endpoint(m.id)}/${kind}`);
  const title =
    kind === "facilities"
      ? t("Instalaciones", "Instalacións")
      : t("Unidades reservables", "Unidades reservables");
  return (
    <section className={styles.section}>
      <h2>{title}</h2>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <SortableDataTable
            rows={query.data.pages.flatMap((p) => p.items)}
            rowKey="id"
            caption={title}
            emptyMessage={t(
              "No hay recursos en este ámbito.",
              "Non hai recursos neste ámbito.",
            )}
            columns={[
              {
                key: "name",
                sortable: false,
                label: t("Nombre", "Nome"),
                render: (_, r) =>
                  permitted(
                    m,
                    "CATALOG_MANAGE",
                    kind === "units" ? r.id : null,
                  ) ? (
                    <Link
                      to={`${municipalPath(m.id)}/${kind === "units" ? "unidades" : "instalaciones"}/${r.id}`}
                    >
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  ),
              },
              {
                key: "publishedAt",
                sortable: false,
                label: t("Estado", "Estado"),
                render: (_, r) =>
                  r.withdrawnAt
                    ? t("Retirada", "Retirada")
                    : r.publishedAt
                      ? t("Publicada", "Publicada")
                      : t("Borrador", "Borrador"),
              },
              ...(kind === "facilities" && permitted(m, "CATALOG_CREATE")
                ? [
                    {
                      key: "create",
                      sortable: false,
                      label: t("Unidades", "Unidades"),
                      render: (_: unknown, r: Resource) =>
                        !r.withdrawnAt ? (
                          <Link
                            to={`${municipalPath(m.id)}/instalaciones/${r.id}/nueva-unidad`}
                          >
                            {t("Crear unidad", "Crear unidade")}
                          </Link>
                        ) : null,
                    },
                  ]
                : []),
            ]}
          />
          <More query={query} />
        </>
      )}
    </section>
  );
}
export function NewUnit() {
  const m = useMunicipality();
  const { resourceId = "" } = useParams();
  const { t } = usePreferences();
  if (!permitted(m, "CATALOG_CREATE")) return <Denied />;
  return (
    <>
      <h1>{t("Nueva unidad reservable", "Nova unidade reservable")}</h1>
      <MunicipalForm
        path={`${endpoint(m.id)}/facilities/${resourceId}/units`}
        resetOnSuccess
        label={t("Crear unidad", "Crear unidade")}
        body={(d) => ({ name: textField(d, "name").trim() })}
      >
        <Input
          name="name"
          label={t("Nombre", "Nome")}
          required
          maxLength={200}
        />
        <p>
          {t(
            "La unidad se crea en borrador. Configura sus horarios y normas antes de publicarla.",
            "A unidade créase en borrador. Configura os seus horarios e normas antes de publicala.",
          )}
        </p>
      </MunicipalForm>
      <Link to={municipalPath(m.id)}>
        {t("Volver al catálogo", "Volver ao catálogo")}
      </Link>
    </>
  );
}
export function ResourcePage({ unit = false }: { unit?: boolean }) {
  const { resourceId = "" } = useParams();
  const m = useMunicipality();
  if (!permitted(m, "CATALOG_MANAGE", unit ? resourceId : null))
    return <Denied />;
  return (
    <ResourceDetails
      key={`${resourceId}:${unit}`}
      unit={unit}
      id={resourceId}
    />
  );
}
function ResourceDetails({ unit, id }: { unit: boolean; id: string }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [tab, setTab] = useState("data");
  const path = `${endpoint(m.id)}/${unit ? "units" : "facilities"}/${id}`;
  const resource = useMunicipalQuery<Resource>(path);
  if (resource.isPending) return <Loading />;
  if (resource.isError && (!resource.data || discardEditor(resource.error)))
    return (
      <Failure error={resource.error} retry={() => void resource.refetch()} />
    );
  if (!resource.data) return null;
  const state = resource.data.withdrawnAt
    ? t("Retirada del catálogo público", "Retirada do catálogo público")
    : resource.data.publishedAt
      ? t("Publicada", "Publicada")
      : t("Borrador", "Borrador");
  const nameForm = (
    <MunicipalForm
      path={path}
      method="PATCH"
      body={(d) => ({ name: textField(d, "name").trim() })}
      label={t("Guardar nombre", "Gardar nome")}
    >
      <Input
        label={t("Nombre", "Nome")}
        name="name"
        defaultValue={resource.data.name}
        required
        maxLength={200}
      />
    </MunicipalForm>
  );
  const withdrawal = (
    <MunicipalForm
      path={`${path}/withdraw`}
      body={(d) => ({ reason: textField(d, "reason") })}
      label={t("Retirar", "Retirar")}
      danger
    >
      <p>
        {t(
          "La retirada impide nuevas reservas. Las reservas existentes y su historial se conservan.",
          "A retirada impide novas reservas. As reservas existentes e o seu historial consérvanse.",
        )}
      </p>
      <Reason />
      <Checkbox
        required
        label={t("Confirmo la retirada", "Confirmo a retirada")}
      />
    </MunicipalForm>
  );
  if (!unit)
    return (
      <EditorRecovery
        error={resource.error}
        retry={() => void resource.refetch()}
      >
        <Link to={municipalPath(m.id)}>{t("Catálogo", "Catálogo")}</Link>
        <h1>{resource.data.name}</h1>
        <p>{state}</p>
        {nameForm}
        <Publication path={path} unit={false} />
        <section className={styles.section}>
          <h2>{t("Retirar del catálogo", "Retirar do catálogo")}</h2>
          {withdrawal}
        </section>
      </EditorRecovery>
    );
  return (
    <EditorRecovery
      error={resource.error}
      retry={() => void resource.refetch()}
    >
      <div className={resourceStyles.page}>
        <PageHeader
          title={resource.data.name}
          description={t(
            "Configura la unidad que los usuarios pueden reservar.",
            "Configura a unidade que os usuarios poden reservar.",
          )}
          status={
            <Badge
              size="sm"
              tone={
                resource.data.withdrawnAt
                  ? "neutral"
                  : resource.data.publishedAt
                    ? "success"
                    : "warning"
              }
            >
              {state}
            </Badge>
          }
          actions={
            <>
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Globe size={16} aria-hidden="true" />
                    {t("Publicar unidad", "Publicar unidade")}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={t("Publicar unidad", "Publicar unidade")}
                  closeLabel={t("Cerrar", "Pechar")}
                >
                  <UnitPublication path={path} />
                </DialogContent>
              </Dialog>
              {!resource.data.withdrawnAt && (
                <Dialog>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="secondary">
                      <Archive size={16} aria-hidden="true" />
                      {t("Retirar del catálogo", "Retirar do catálogo")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent
                    title={t("Retirar del catálogo", "Retirar do catálogo")}
                    closeLabel={t("Cerrar", "Pechar")}
                  >
                    {withdrawal}
                  </DialogContent>
                </Dialog>
              )}
            </>
          }
        />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList
            aria-label={t(
              "Configuración de la unidad",
              "Configuración da unidade",
            )}
          >
            <TabsTrigger value="data">
              <Settings2 size={16} aria-hidden="true" />
              {t("Datos", "Datos")}
            </TabsTrigger>
            <TabsTrigger value="calendar">
              <Clock3 size={16} aria-hidden="true" />
              {t("Horarios", "Horarios")}
            </TabsTrigger>
            <TabsTrigger value="rules">
              <FileText size={16} aria-hidden="true" />
              {t("Normas", "Normas")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="data" forceMount>
            <section className={resourceStyles.group}>
              <div>
                <h2>{t("Datos de la unidad", "Datos da unidade")}</h2>
                <p>
                  {t(
                    "Este nombre identifica la unidad en el catálogo público y en las reservas.",
                    "Este nome identifica a unidade no catálogo público e nas reservas.",
                  )}
                </p>
              </div>
              <div>{nameForm}</div>
            </section>
            {!resource.data.publishedAt && (
              <div className={resourceStyles.hint}>
                {t(
                  "Antes de publicar, completa las normas de uso y los horarios. La instalación también debe estar publicada.",
                  "Antes de publicar, completa as normas de uso e os horarios. A instalación tamén debe estar publicada.",
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="calendar" forceMount>
            <CalendarEditor path={path} />
          </TabsContent>
          <TabsContent value="rules" forceMount>
            <RulesEditor path={path} />
          </TabsContent>
        </Tabs>
      </div>
    </EditorRecovery>
  );
}

function Publication({ path, unit }: { path: string; unit: boolean }) {
  const { t } = usePreferences();
  return (
    <section className={styles.section}>
      <h2>{t("Publicación", "Publicación")}</h2>
      {unit ? (
        <UnitPublication path={path} />
      ) : (
        <MunicipalForm
          path={`${path}/publish`}
          body={(d) => ({ reason: textField(d, "reason") })}
          label={t("Publicar instalación", "Publicar instalación")}
        >
          <Reason />
        </MunicipalForm>
      )}
    </section>
  );
}
function UnitPublication({ path }: { path: string }) {
  const { t } = usePreferences();
  const calendar = useMunicipalQuery<{ version: number }>(
    `${path}/calendar`,
    true,
    false,
  );
  const rules = useMunicipalQuery<{ version: number }>(
    `${path}/usage-rules`,
    true,
    false,
  );
  if (calendar.isPending || rules.isPending) return <Loading />;
  if (calendar.isError || rules.isError)
    return <Failure error={calendar.error ?? rules.error} />;
  if (!rules.data)
    return (
      <p className={styles.notice}>
        {t(
          "Añade las normas de uso para publicar esta unidad.",
          "Engade as normas de uso para publicar esta unidade.",
        )}
      </p>
    );
  if (!calendar.data)
    return (
      <p>
        {t(
          "Configura los horarios antes de publicar.",
          "Configura os horarios antes de publicar.",
        )}
      </p>
    );
  return (
    <MunicipalForm
      path={`${path}/publish`}
      label={t("Publicar unidad", "Publicar unidade")}
      body={(d) => ({
        reason: textField(d, "reason"),
        calendarVersion: calendar.data?.version,
        independenceConfirmed: true,
      })}
    >
      <p>
        {t(
          "La instalación debe estar publicada. El sistema comprueba la versión de horarios y las normas vigentes.",
          "A instalación debe estar publicada. O sistema comproba a versión de horarios e as normas vixentes.",
        )}
      </p>
      <Reason />
      <Checkbox
        required
        label={t(
          "La unidad es independiente y no se solapa con otro espacio reservable.",
          "A unidade é independente e non se solapa con outro espazo reservable.",
        )}
      />
    </MunicipalForm>
  );
}
