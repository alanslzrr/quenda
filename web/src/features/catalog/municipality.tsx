import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Link, useParams } from "react-router";
import {
  type Appearance,
  api,
  type Municipality,
  type Page,
} from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
export function MunicipalityPage() {
  const { tenantId } = useParams();
  const { locale, t } = usePreferences();
  const municipality = useQuery({
    queryKey: ["public", tenantId, "municipality"],
    queryFn: ({ signal }) =>
      api<Municipality>(
        `/api/public/municipalities/${tenantId}`,
        { signal },
        locale,
      ),
  });
  const appearance = useQuery({
    queryKey: ["public", tenantId, "appearance"],
    queryFn: ({ signal }) =>
      api<Appearance>(
        `/api/public/municipalities/${tenantId}/appearance`,
        { signal },
        locale,
      ),
  });
  useMunicipalTheme(appearance.data);
  const facilities = useInfiniteQuery({
    queryKey: ["public", tenantId, "facilities", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ id: string; name: string }>>(
        `/api/public/municipalities/${tenantId}/facilities${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  if (municipality.isPending || facilities.isPending) return <Loading />;
  if (municipality.isError || facilities.isError)
    return (
      <Failure
        error={municipality.error ?? facilities.error}
        retry={() => {
          void municipality.refetch();
          void facilities.refetch();
        }}
      />
    );
  return (
    <>
      <Link to="/">{t("Todos los municipios", "Todos os municipios")}</Link>
      <div className={styles.hero}>
        <p className={styles.eyebrow} style={{ marginTop: "2rem" }}>
          {t("Deporte municipal", "Deporte municipal")}
        </p>
        <h1 className={styles.title}>{municipality.data.name}</h1>
        <p className={styles.description}>
          {t(
            "Instalaciones y unidades reservables del municipio.",
            "Instalacións e unidades reservables do municipio.",
          )}
        </p>
      </div>
      {facilities.data.pages
        .flatMap((page) => page.items)
        .map((facility) => (
          <Facility
            key={facility.id}
            tenantId={tenantId ?? ""}
            facility={facility}
          />
        ))}
      {facilities.data.pages[0].items.length === 0 && (
        <p className={styles.empty}>
          {t(
            "No hay instalaciones publicadas.",
            "Non hai instalacións publicadas.",
          )}
        </p>
      )}
      {facilities.hasNextPage && (
        <Button
          loading={facilities.isFetchingNextPage}
          onClick={() => void facilities.fetchNextPage()}
        >
          {t("Ver más", "Ver máis")}
        </Button>
      )}
    </>
  );
}
function Facility({
  tenantId,
  facility,
}: {
  tenantId: string;
  facility: { id: string; name: string };
}) {
  const { locale, t } = usePreferences();
  const units = useInfiniteQuery({
    queryKey: ["public", tenantId, facility.id, "units", locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<{ id: string; name: string }>>(
        `/api/public/municipalities/${tenantId}/facilities/${facility.id}/units${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <section>
      <h2 className={styles.sectionTitle}>{facility.name}</h2>
      {units.isPending ? (
        <Loading />
      ) : units.isError ? (
        <Failure error={units.error} retry={() => void units.refetch()} />
      ) : (
        <>
          <ul className={styles.list}>
            {units.data.pages
              .flatMap((page) => page.items)
              .map((unit) => (
                <li className={styles.listItem} key={unit.id}>
                  <Link
                    className={styles.listLink}
                    to={`/municipios/${tenantId}/unidades/${unit.id}`}
                  >
                    <span className={styles.listTitle}>{unit.name}</span>
                    <ArrowRight size={20} aria-hidden="true" />
                  </Link>
                </li>
              ))}
          </ul>
          {units.data.pages[0].items.length === 0 && (
            <p className={styles.empty}>
              {t("No hay unidades publicadas.", "Non hai unidades publicadas.")}
            </p>
          )}
          {units.hasNextPage && (
            <Button
              variant="secondary"
              loading={units.isFetchingNextPage}
              onClick={() => void units.fetchNextPage()}
            >
              {t("Ver más unidades", "Ver máis unidades")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
