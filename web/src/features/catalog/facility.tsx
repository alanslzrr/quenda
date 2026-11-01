import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api, type Page } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import styles from "./booking.module.css";
import { durationLabel } from "./dates";
import {
  BookingSteps,
  Choice,
  Choices,
  municipalityPath,
  searchPath,
  unitPath,
  useJourneyQuery,
} from "./journey";
import {
  MunicipalityGone,
  useMunicipality,
  usePublicAppearance,
} from "./municipality";
import { useFacilities } from "./search";

interface UnitChoice {
  id: string;
  name: string;
  facilityId: string;
  minimumMinutes: number;
  maximumMinutes: number;
}

function useUnits(tenantId: string, facilityId: string) {
  const { locale } = usePreferences();
  const query = useInfiniteQuery({
    queryKey: ["public", tenantId, "facility-units", facilityId, locale],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<Page<UnitChoice>>(
        `/api/public/municipalities/${tenantId}/facilities/${facilityId}/units${pageParam ? `?after=${pageParam}` : ""}`,
        { signal },
        locale,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  useEffect(() => {
    // An unsuccessful page needs an explicit retry, never an automatic request loop.
    if (query.hasNextPage && !query.isFetching && !query.isError)
      void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  return {
    ...query,
    loading:
      query.isPending || (!query.isError && (query.hasNextPage ?? false)),
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

/** Third step: the units of one facility, with what tells them apart. */
export function FacilityPage() {
  const { tenantId = "", facilityId = "" } = useParams();
  const { locale, t } = usePreferences();
  const query = useJourneyQuery();
  const municipality = useMunicipality(tenantId);
  const facilities = useFacilities(tenantId);
  const units = useUnits(tenantId, facilityId);
  usePublicAppearance(tenantId);
  if (municipality.isPending || facilities.loading) return <Loading />;
  if (municipality.isError)
    return municipality.error instanceof ApiError &&
      municipality.error.status === 404 ? (
      <MunicipalityGone tenantId={tenantId} />
    ) : (
      <Failure
        error={municipality.error}
        retry={() => void municipality.refetch()}
      />
    );
  if (facilities.isError)
    return (
      <Failure
        error={facilities.error}
        retry={() => void facilities.refetch()}
      />
    );
  const name = municipality.data.name;
  const facility = facilities.items.find((item) => item.id === facilityId);
  const back = municipalityPath(tenantId, query);
  if (!facility)
    return (
      <div className={styles.page}>
        <BookingSteps
          current={1}
          tenantId={tenantId}
          municipality={name}
          query={query}
        />
        <div className={styles.empty}>
          <p>
            {t(
              "Esta instalación no está disponible.",
              "Esta instalación non está dispoñible.",
            )}
          </p>
          <span>
            {t(
              `Puede que el ayuntamiento la haya retirado. Elige otra instalación de ${name}.`,
              `Pode que o concello a retirase. Escolle outra instalación de ${name}.`,
            )}
          </span>
        </div>
        <LinkButton to={back} variant="primary">
          {t("Ver instalaciones", "Ver instalacións")}
        </LinkButton>
      </div>
    );
  const items = [...units.items].sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
  const lengths = (unit: UnitChoice) =>
    unit.minimumMinutes === unit.maximumMinutes
      ? t(
          `Reservas de ${durationLabel(unit.minimumMinutes)}`,
          `Reservas de ${durationLabel(unit.minimumMinutes)}`,
        )
      : t(
          `Reservas de ${durationLabel(unit.minimumMinutes)} a ${durationLabel(unit.maximumMinutes)}`,
          `Reservas de ${durationLabel(unit.minimumMinutes)} a ${durationLabel(unit.maximumMinutes)}`,
        );
  const search = new URLSearchParams(query.slice(1));
  search.set("instalacion", facilityId);
  return (
    <div className={styles.page}>
      <BookingSteps
        current={2}
        tenantId={tenantId}
        municipality={name}
        facility={facility}
        query={query}
      />
      <header className={styles.intro}>
        <p className={styles.context}>
          {name} · {facility.name}
        </p>
        <h1 className={styles.title}>
          {t("Elige un espacio", "Escolle un espazo")}
        </h1>
        <p className={styles.lead}>
          {t(
            "Cada espacio se reserva entero y por separado. Después elegirás el día y la hora.",
            "Cada espazo resérvase enteiro e por separado. Despois escollerás o día e a hora.",
          )}
        </p>
        <div className={styles.introActions}>
          <Link className={styles.textLink} to={back}>
            {t("Cambiar instalación", "Cambiar instalación")}
          </Link>
        </div>
      </header>
      {units.isError ? (
        <Failure error={units.error} retry={() => void units.refetch()} />
      ) : units.loading ? (
        <Loading />
      ) : !items.length ? (
        <>
          <div className={styles.empty}>
            <p>
              {t(
                "Esta instalación no tiene espacios reservables ahora mismo.",
                "Esta instalación non ten espazos reservables agora mesmo.",
              )}
            </p>
            <span>
              {t(
                "Prueba con otra instalación del municipio.",
                "Proba con outra instalación do municipio.",
              )}
            </span>
          </div>
          <LinkButton to={back}>
            {t("Ver otras instalaciones", "Ver outras instalacións")}
          </LinkButton>
        </>
      ) : (
        <div className={styles.sections}>
          <Choices>
            {items.map((unit) => (
              <Choice
                key={unit.id}
                to={unitPath(tenantId, unit.id, query)}
                title={unit.name}
                meta={lengths(unit)}
              />
            ))}
          </Choices>
          {items.length > 1 && (
            <p className={styles.quiet}>
              <Link
                className={styles.textLink}
                to={searchPath(tenantId, `?${search}`)}
              >
                {t(
                  "Ver horarios libres de todos sus espacios",
                  "Ver horarios libres de todos os seus espazos",
                )}
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
