import { Link, Navigate, useParams } from "react-router";
import { textField } from "../../app/action";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import { CalendarEditor, RulesEditor } from "./configuration";
import styles from "./municipal.module.css";
import {
  Denied,
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
  if (!hasCatalog)
    return <Navigate replace to={`${municipalPath(m.id)}/agenda`} />;
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
  const path = `${endpoint(m.id)}/${unit ? "units" : "facilities"}/${id}`;
  const resource = useMunicipalQuery<Resource>(path);
  if (resource.isPending) return <Loading />;
  if (resource.isError)
    return (
      <Failure error={resource.error} retry={() => void resource.refetch()} />
    );
  if (!resource.data) return null;
  return (
    <>
      <Link to={municipalPath(m.id)}>{t("Catálogo", "Catálogo")}</Link>
      <h1>{resource.data.name}</h1>
      <p>
        {resource.data.withdrawnAt
          ? t("Retirada del catálogo público", "Retirada do catálogo público")
          : resource.data.publishedAt
            ? t("Publicada", "Publicada")
            : t("Borrador", "Borrador")}
      </p>
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
      {unit && (
        <>
          <RulesEditor path={path} />
          <CalendarEditor path={path} />
        </>
      )}
      <Publication path={path} unit={unit} />
      <section className={styles.section}>
        <h2>{t("Retirar del catálogo", "Retirar do catálogo")}</h2>
        <MunicipalForm
          path={`${path}/withdraw`}
          body={(d) => ({ reason: textField(d, "reason") })}
          label={t("Retirar", "Retirar")}
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
      </section>
    </>
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
  );
  const rules = useMunicipalQuery<{ version: number }>(
    `${path}/usage-rules`,
    true,
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
