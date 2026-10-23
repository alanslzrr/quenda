import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, MapPin } from "lucide-react";
import { Link } from "react-router";
import { api, type Municipality, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import styles from "../../app/layout.module.css";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Button } from "../../ui/button/button";
import directory from "./directory.module.css";
export function Directory() {
  useMunicipalTheme(undefined);
  const { locale, t } = usePreferences();
  const query = useInfiniteQuery({
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
  return (
    <>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>
          {t(
            "Instalaciones deportivas municipales",
            "Instalacións deportivas municipais",
          )}
        </p>
        <h1 className={styles.title}>
          {t(
            "Reserva instalaciones deportivas.",
            "Reserva instalacións deportivas.",
          )}
        </h1>
        <p className={styles.description}>
          {t(
            "Elige un municipio para consultar sus instalaciones y los horarios disponibles.",
            "Escolle un municipio para consultar as súas instalacións e os horarios dispoñibles.",
          )}
        </p>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className={directory.municipalities}>
            {query.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <li key={item.id}>
                  <Link to={`/municipios/${item.id}`}>
                    <MapPin size={24} aria-hidden="true" />
                    <span>
                      <span className={styles.listTitle}>{item.name}</span>
                      <span className={styles.listMeta}>
                        {t("Consultar instalaciones", "Consultar instalacións")}
                      </span>
                    </span>
                    <ArrowRight size={22} aria-hidden="true" />
                  </Link>
                </li>
              ))}
          </ul>
          {query.data.pages[0].items.length === 0 && (
            <p className={styles.empty}>
              <MapPin size={20} aria-hidden="true" />{" "}
              {t(
                "Todavía no hay municipios disponibles.",
                "Aínda non hai municipios dispoñibles.",
              )}
            </p>
          )}
          {query.hasNextPage && (
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("Ver más municipios", "Ver máis municipios")}
            </Button>
          )}
        </>
      )}
    </>
  );
}
