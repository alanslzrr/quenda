import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Clock3,
  FileText,
  Globe,
  Image as ImageIcon,
  Plus,
  ScrollText,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { Navigate, useParams } from "react-router";
import { ActionForm, textField } from "../../app/action";
import { ApiError, api } from "../../app/api";
import { saveFile } from "../../app/download";
import { Failure, Loading } from "../../app/feedback";
import { BackLink, LinkButton, RowLink } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Badge } from "../../ui/badge/badge";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Dialog, DialogContent, DialogTrigger } from "../../ui/dialog/dialog";
import { Input } from "../../ui/input/input";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs/tabs";
import type { CatalogPhoto } from "../catalog/photos";
import type { FacilityProfile, UnitProfile } from "../catalog/profile";
import { CalendarEditor, RulesEditor } from "./configuration";
import { landingSection } from "./landing.ts";
import styles from "./municipal.module.css";
import { ManagementPage } from "./page";
import { PhotoManager } from "./photo-manager";
import { FacilityProfileEditor, UnitProfileEditor } from "./profile-editor";
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
  profile?: FacilityProfile & UnitProfile;
  profileVersion?: number;
  photos?: CatalogPhoto[];
};
function CatalogDownload() {
  const m = useMunicipality();
  const { locale, t } = usePreferences();
  return (
    <section className={styles.section}>
      <h2>{t("Copia del catálogo", "Copia do catálogo")}</h2>
      <p>
        {t(
          "Descarga un archivo con los ajustes del municipio, las instalaciones y espacios con su ficha, los horarios y las normas vigentes. No incluye reservas ni datos personales.",
          "Descarga un arquivo cos axustes do municipio, as instalacións e espazos coa súa ficha, os horarios e as normas vixentes. Non inclúe reservas nin datos persoais.",
        )}
      </p>
      <ActionForm
        label={t("Descargar catálogo", "Descargar catálogo")}
        success={t(
          "Archivo preparado para descargar.",
          "Arquivo preparado para descargar.",
        )}
        resetOnSuccess={false}
        submit={async () => {
          saveFile(
            "quenda-catalog-v1.json",
            JSON.stringify(
              await api(`${endpoint(m.id)}/exports/catalog`, {}, locale),
              null,
              2,
            ),
            "application/json",
          );
        }}
      />
    </section>
  );
}
interface ImportResult {
  facilities: number;
  units: number;
  calendars: number;
  usageRules: number;
  skippedWithdrawn: number;
  settings: { bookingPolicy: boolean; appearance: boolean };
}
function appliedSettings(
  settings: ImportResult["settings"],
  t: (es: string, gl: string) => string,
) {
  if (settings.bookingPolicy && settings.appearance)
    return t(
      " También se aplicaron la política de reserva y la apariencia del archivo.",
      " Tamén se aplicaron a política de reserva e a aparencia do arquivo.",
    );
  if (settings.bookingPolicy)
    return t(
      " También se aplicó la política de reserva del archivo; la apariencia ya coincidía.",
      " Tamén se aplicou a política de reserva do arquivo; a aparencia xa coincidía.",
    );
  if (settings.appearance)
    return t(
      " También se aplicó la apariencia del archivo; la política de reserva ya coincidía.",
      " Tamén se aplicou a aparencia do arquivo; a política de reserva xa coincidía.",
    );
  return "";
}
/** Loads a quenda.catalog file into a municipality that has no facilities yet. */
function CatalogImport() {
  const m = useMunicipality();
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  // Same paged query (and cache entry) as the facility list on this page.
  const facilities = useMunicipalPages<Resource>(
    `${endpoint(m.id)}/facilities`,
  );
  const [result, setResult] = useState<ImportResult>();
  // One key per chosen file: retrying after a lost response replays, never duplicates.
  const [key, setKey] = useState(() => crypto.randomUUID());
  if (
    !result &&
    (facilities.isPending || facilities.data?.pages[0]?.items.length !== 0)
  )
    return null;
  return (
    <section className={styles.section}>
      <h2>{t("Importar un catálogo", "Importar un catálogo")}</h2>
      {result ? (
        <p role="status">
          {t(
            `Importadas ${result.facilities} instalaciones y ${result.units} unidades, con ${result.calendars} horarios y ${result.usageRules} normas. Están en borrador: revísalas y publícalas. ${result.skippedWithdrawn ? `Se omitieron ${result.skippedWithdrawn} recursos retirados.` : ""}`,
            `Importadas ${result.facilities} instalacións e ${result.units} unidades, con ${result.calendars} horarios e ${result.usageRules} normas. Están en borrador: revísaas e publícaas. ${result.skippedWithdrawn ? `Omitíronse ${result.skippedWithdrawn} recursos retirados.` : ""}`,
          )}
          {appliedSettings(result.settings, t)}
        </p>
      ) : (
        <>
          <p>
            {t(
              "El municipio todavía no tiene instalaciones. Puedes cargar el archivo que descarga «Copia del catálogo» en este u otro municipio o instalación de Quenda. Se crean instalaciones y unidades en borrador con su ficha, horario y normas; no se importan reservas ni recursos retirados.",
              "O municipio aínda non ten instalacións. Podes cargar o arquivo que descarga «Copia do catálogo» neste ou noutro municipio ou instalación de Quenda. Créanse instalacións e unidades en borrador coa súa ficha, horario e normas; non se importan reservas nin recursos retirados.",
            )}
          </p>
          <ActionForm
            label={t("Importar catálogo", "Importar catálogo")}
            resetOnSuccess={false}
            submit={async (data) => {
              const file = data.get("file");
              let document: unknown;
              try {
                if (!(file instanceof File) || file.size === 0)
                  throw new Error("missing");
                document = JSON.parse(await file.text());
              } catch {
                throw new ApiError(
                  400,
                  "INVALID_INPUT",
                  t(
                    "Elige un archivo de catálogo descargado de Quenda.",
                    "Escolle un arquivo de catálogo descargado de Quenda.",
                  ),
                );
              }
              const imported = await api<ImportResult>(
                `${endpoint(m.id)}/imports/catalog${data.get("settings") ? "?settings=include" : ""}`,
                {
                  method: "POST",
                  body: JSON.stringify(document),
                  headers: { "idempotency-key": key },
                },
                locale,
              );
              setResult(imported);
              await client.invalidateQueries({
                queryKey: ["private", account?.accountId, "municipal"],
              });
              // The municipal colours shown to everyone come from the public read.
              if (imported.settings.appearance)
                await client.invalidateQueries({
                  queryKey: ["public", m.id, "appearance"],
                });
            }}
          >
            <Input
              type="file"
              name="file"
              accept="application/json,.json"
              required
              label={t("Archivo de catálogo", "Arquivo de catálogo")}
              onChange={() => setKey(crypto.randomUUID())}
            />
            <Checkbox
              name="settings"
              label={t(
                "Aplicar también la política de reserva y la apariencia del archivo",
                "Aplicar tamén a política de reserva e a aparencia do arquivo",
              )}
              description={t(
                "Sustituyen la antelación, el plazo de cancelación, las paletas y el tema inicial de este municipio. Cada cambio queda registrado como una edición.",
                "Substitúen a antelación, o prazo de cancelación, as paletas e o tema inicial deste municipio. Cada cambio queda rexistrado como unha edición.",
              )}
              onCheckedChange={() => setKey(crypto.randomUUID())}
            />
          </ActionForm>
        </>
      )}
    </section>
  );
}
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
      <ManagementPage
        title={t("Sin secciones de gestión", "Sen seccións de xestión")}
        description={t(
          "Tus permisos en este municipio no abren ninguna sección de gestión.",
          "Os teus permisos neste municipio non abren ningunha sección de xestión.",
        )}
      >
        <LinkButton to="/administracion">
          {t("Volver a Gestión", "Volver a Xestión")}
        </LinkButton>
      </ManagementPage>
    );
  }
  const creates = permitted(m, "CATALOG_CREATE");
  return (
    <ManagementPage
      title={t("Instalaciones y unidades", "Instalacións e unidades")}
      description={t(
        "Lo que la ciudadanía puede reservar: cada instalación agrupa sus unidades. Entra en una para cambiar su ficha, horario, normas y fotos.",
        "O que a cidadanía pode reservar: cada instalación agrupa as súas unidades. Entra nunha para cambiar a súa ficha, horario, normas e fotos.",
      )}
      actions={
        creates ? (
          <Button
            size="sm"
            onClick={() => {
              // The form lives at the end of the page; take the person there with the name field ready.
              const form = document.getElementById("nueva-instalacion");
              form?.scrollIntoView({ behavior: "smooth", block: "start" });
              form?.querySelector("input")?.focus({ preventScroll: true });
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t("Nueva instalación", "Nova instalación")}
          </Button>
        ) : undefined
      }
    >
      <ResourceList kind="facilities" />
      <ResourceList kind="units" />
      {m.administrator && <CatalogImport />}
      {creates && (
        <section className={styles.section} id="nueva-instalacion">
          <h2>{t("Nueva instalación", "Nova instalación")}</h2>
          <p>
            {t(
              "Empieza por el nombre; después añade sus unidades, la ficha y las fotos. Se crea en borrador y nadie la ve hasta que la publiques.",
              "Comeza polo nome; despois engade as súas unidades, a ficha e as fotos. Créase en borrador e ninguén a ve ata que a publiques.",
            )}
          </p>
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
      {m.administrator && <CatalogDownload />}
    </ManagementPage>
  );
}
/** Published, draft or withdrawn, as the same badge the unit page shows. */
export function ResourceState({
  resource,
  detailed = false,
}: {
  resource: Resource;
  /** On the resource's own page, a withdrawal says where it was withdrawn from. */
  detailed?: boolean;
}) {
  const { t } = usePreferences();
  return (
    <Badge
      size="sm"
      tone={
        resource.withdrawnAt
          ? "neutral"
          : resource.publishedAt
            ? "success"
            : "warning"
      }
    >
      {resource.withdrawnAt
        ? detailed
          ? t("Retirada del catálogo público", "Retirada do catálogo público")
          : t("Retirada", "Retirada")
        : resource.publishedAt
          ? t("Publicada", "Publicada")
          : t("Borrador", "Borrador")}
    </Badge>
  );
}
function ResourceList({ kind }: { kind: "facilities" | "units" }) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const query = useMunicipalPages<Resource>(`${endpoint(m.id)}/${kind}`);
  // The other list of the page shares its cache entry, so counts and names cost no extra request.
  const other = useMunicipalPages<Resource>(
    `${endpoint(m.id)}/${kind === "facilities" ? "units" : "facilities"}`,
  );
  const others = other.data?.pages.flatMap((p) => p.items) ?? [];
  const title =
    kind === "facilities"
      ? t("Instalaciones", "Instalacións")
      : t("Unidades reservables", "Unidades reservables");
  const creates = kind === "facilities" && permitted(m, "CATALOG_CREATE");
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
            locale={locale}
            rows={query.data.pages.flatMap((p) => p.items)}
            rowKey="id"
            caption={title}
            emptyMessage={
              kind === "facilities"
                ? t(
                    "Todavía no hay instalaciones. Crea la primera con «Nueva instalación».",
                    "Aínda non hai instalacións. Crea a primeira con «Nova instalación».",
                  )
                : t(
                    "Todavía no hay unidades. Créalas desde su instalación.",
                    "Aínda non hai unidades. Créaas desde a súa instalación.",
                  )
            }
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
                    <RowLink
                      to={`${municipalPath(m.id)}/${kind === "units" ? "unidades" : "instalaciones"}/${r.id}`}
                    >
                      {r.name}
                    </RowLink>
                  ) : (
                    r.name
                  ),
              },
              kind === "facilities"
                ? {
                    key: "units",
                    sortable: false,
                    width: "8rem",
                    label: t("Unidades", "Unidades"),
                    render: (_: unknown, r: Resource) =>
                      other.data
                        ? others.filter((u) => u.facilityId === r.id).length
                        : "—",
                  }
                : {
                    key: "facilityId",
                    sortable: false,
                    label: t("Instalación", "Instalación"),
                    render: (_: unknown, r: Resource) =>
                      others.find((f) => f.id === r.facilityId)?.name ?? "—",
                  },
              {
                key: "publishedAt",
                sortable: false,
                width: "8rem",
                label: t("Estado", "Estado"),
                render: (_, r) => <ResourceState resource={r} />,
              },
              ...(creates
                ? [
                    {
                      key: "create",
                      sortable: false,
                      width: "9rem",
                      label: t("Acciones", "Accións"),
                      render: (_: unknown, r: Resource) =>
                        !r.withdrawnAt ? (
                          <LinkButton
                            to={`${municipalPath(m.id)}/instalaciones/${r.id}/nueva-unidad`}
                            variant="secondary"
                            aria-label={t(
                              `Crear unidad en ${r.name}`,
                              `Crear unidade en ${r.name}`,
                            )}
                          >
                            <Plus size={14} aria-hidden="true" />
                            {t("Unidad", "Unidade")}
                          </LinkButton>
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
    <ManagementPage
      title={t("Nueva unidad reservable", "Nova unidade reservable")}
      description={t(
        "La unidad se crea en borrador. Configura sus horarios y normas antes de publicarla.",
        "A unidade créase en borrador. Configura os seus horarios e normas antes de publicala.",
      )}
      breadcrumb={
        <BackLink to={municipalPath(m.id)}>
          {t("Volver al catálogo", "Volver ao catálogo")}
        </BackLink>
      }
    >
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
      </MunicipalForm>
    </ManagementPage>
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
  // Publishing is offered only while it would change something: a draft or a withdrawn resource.
  const publishable = !resource.data.publishedAt || !!resource.data.withdrawnAt;
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
  const kind = unit
    ? {
        description: t(
          "Lo que la ciudadanía ve y reserva de esta unidad: su ficha y fotos, sus horarios y sus normas.",
          "O que a cidadanía ve e reserva desta unidade: a súa ficha e fotos, os seus horarios e as súas normas.",
        ),
        publish: resource.data.withdrawnAt
          ? t("Volver a publicar unidad", "Volver publicar unidade")
          : t("Publicar unidad", "Publicar unidade"),
        tabs: t("Configuración de la unidad", "Configuración da unidade"),
        data: t("Datos de la unidad", "Datos da unidade"),
        dataHint: t(
          "Este nombre identifica la unidad en el catálogo público y en las reservas.",
          "Este nome identifica a unidade no catálogo público e nas reservas.",
        ),
      }
    : {
        description: t(
          "La instalación agrupa unidades reservables. Su ficha y sus fotos se muestran a la ciudadanía antes de elegir una unidad.",
          "A instalación agrupa unidades reservables. A súa ficha e as súas fotos amósanse á cidadanía antes de escoller unha unidade.",
        ),
        publish: resource.data.withdrawnAt
          ? t("Volver a publicar instalación", "Volver publicar instalación")
          : t("Publicar instalación", "Publicar instalación"),
        tabs: t(
          "Configuración de la instalación",
          "Configuración da instalación",
        ),
        data: t("Datos de la instalación", "Datos da instalación"),
        dataHint: t(
          "Este nombre identifica la instalación en el catálogo público.",
          "Este nome identifica a instalación no catálogo público.",
        ),
      };
  // Facilities and units share one layout: actions in the header, one tab per concern.
  return (
    <EditorRecovery
      error={resource.error}
      retry={() => void resource.refetch()}
    >
      <ManagementPage
        title={resource.data.name}
        description={kind.description}
        breadcrumb={
          <BackLink to={municipalPath(m.id)}>
            {t("Catálogo", "Catálogo")}
          </BackLink>
        }
        status={<ResourceState resource={resource.data} detailed />}
        actions={
          <>
            {!resource.data.withdrawnAt && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" variant="danger-ghost">
                    <Archive size={16} aria-hidden="true" />
                    {t("Retirar del catálogo", "Retirar do catálogo")}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={t("Retirar del catálogo", "Retirar do catálogo")}
                  closeLabel={t("Cerrar", "Pechar")}
                  initialFocus="field"
                >
                  {withdrawal}
                </DialogContent>
              </Dialog>
            )}
            {publishable && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Globe size={16} aria-hidden="true" />
                    {kind.publish}
                  </Button>
                </DialogTrigger>
                <DialogContent
                  title={kind.publish}
                  closeLabel={t("Cerrar", "Pechar")}
                  initialFocus="field"
                >
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
                </DialogContent>
              </Dialog>
            )}
          </>
        }
      >
        <div className={resourceStyles.page}>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList
              scrollLabels={{
                previous: t("Anterior", "Anterior"),
                next: t("Siguiente", "Seguinte"),
              }}
              aria-label={kind.tabs}
            >
              <TabsTrigger value="data">
                <Settings2 size={16} aria-hidden="true" />
                {t("Datos", "Datos")}
              </TabsTrigger>
              <TabsTrigger value="profile">
                <FileText size={16} aria-hidden="true" />
                {t("Ficha", "Ficha")}
              </TabsTrigger>
              <TabsTrigger value="photos">
                <ImageIcon size={16} aria-hidden="true" />
                {t("Fotos", "Fotos")}
              </TabsTrigger>
              {unit && (
                <TabsTrigger value="calendar">
                  <Clock3 size={16} aria-hidden="true" />
                  {t("Horarios", "Horarios")}
                </TabsTrigger>
              )}
              {unit && (
                <TabsTrigger value="rules">
                  <ScrollText size={16} aria-hidden="true" />
                  {t("Normas", "Normas")}
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent
              value="data"
              forceMount
              className={resourceStyles.panel}
            >
              <section className={resourceStyles.group}>
                <div>
                  <h2>{kind.data}</h2>
                  <p>{kind.dataHint}</p>
                </div>
                <div>{nameForm}</div>
              </section>
              {!unit && <FacilityUnits facilityId={id} />}
              {unit && !resource.data.publishedAt && (
                <div className={resourceStyles.hint}>
                  {t(
                    "Antes de publicar, completa las normas de uso y los horarios. La instalación también debe estar publicada.",
                    "Antes de publicar, completa as normas de uso e os horarios. A instalación tamén debe estar publicada.",
                  )}
                </div>
              )}
            </TabsContent>
            <TabsContent
              value="profile"
              forceMount
              className={resourceStyles.panel}
            >
              {unit ? (
                <UnitProfileEditor
                  path={path}
                  profile={resource.data.profile ?? {}}
                  version={resource.data.profileVersion ?? 1}
                />
              ) : (
                <FacilityProfileEditor
                  path={path}
                  profile={resource.data.profile ?? {}}
                  version={resource.data.profileVersion ?? 1}
                />
              )}
            </TabsContent>
            <TabsContent
              value="photos"
              forceMount
              className={resourceStyles.panel}
            >
              <PhotoManager
                path={path}
                kind={unit ? "unit" : "facility"}
                name={resource.data.name}
                photos={resource.data.photos ?? []}
              />
            </TabsContent>
            {unit && (
              <TabsContent
                value="calendar"
                forceMount
                className={resourceStyles.panel}
              >
                <CalendarEditor path={path} />
              </TabsContent>
            )}
            {unit && (
              <TabsContent
                value="rules"
                forceMount
                className={resourceStyles.panel}
              >
                <RulesEditor path={path} />
              </TabsContent>
            )}
          </Tabs>
        </div>
      </ManagementPage>
    </EditorRecovery>
  );
}

/** The units of one facility, with a way to add another, on the facility's own page. */
function FacilityUnits({ facilityId }: { facilityId: string }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const units = useMunicipalPages<Resource>(`${endpoint(m.id)}/units`);
  const own = (units.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (u) => u.facilityId === facilityId,
  );
  return (
    <section className={resourceStyles.group}>
      <div>
        <h2>{t("Unidades", "Unidades")}</h2>
        <p>
          {t(
            "Cada unidad se reserva por separado y tiene sus propios horarios y normas.",
            "Cada unidade resérvase por separado e ten os seus propios horarios e normas.",
          )}
        </p>
      </div>
      <div className={resourceStyles.units}>
        {units.isPending ? (
          <Loading />
        ) : units.isError ? (
          <Failure error={units.error} retry={() => void units.refetch()} />
        ) : (
          <>
            {own.length ? (
              <ul>
                {own.map((u) => (
                  <li key={u.id}>
                    {permitted(m, "CATALOG_MANAGE", u.id) ? (
                      <RowLink to={`${municipalPath(m.id)}/unidades/${u.id}`}>
                        {u.name}
                      </RowLink>
                    ) : (
                      u.name
                    )}
                    <ResourceState resource={u} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {t("Todavía no tiene unidades.", "Aínda non ten unidades.")}
              </p>
            )}
            {permitted(m, "CATALOG_CREATE") && (
              <LinkButton
                to={`${municipalPath(m.id)}/instalaciones/${facilityId}/nueva-unidad`}
                variant="secondary"
              >
                <Plus size={14} aria-hidden="true" />
                {t("Crear unidad", "Crear unidade")}
              </LinkButton>
            )}
          </>
        )}
      </div>
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
