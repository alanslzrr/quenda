import { Building2, Clock3 } from "lucide-react";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../../app/api";
import { useMunicipality, usePublicAppearance } from "../../app/branding";
import { useFavorite } from "../../app/favorite";
import { Failure, Loading } from "../../app/feedback";
import { LinkButton } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { BackLink } from "./booking";
import styles from "./booking.module.css";
import {
  BookingSteps,
  Choice,
  Choices,
  FavoriteToggle,
  facilityPath,
  JourneyLoading,
  municipalityPath,
  pickerPath,
  searchPath,
  useJourneyQuery,
} from "./journey";
import { PhotoThumb } from "./photo-gallery";
import { publicPhotos } from "./photos";
import { addressLine } from "./profile";
import { AvailabilitySearch, useFacilities } from "./search";

const missing = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

/** A municipality that no longer exists stops being the starting point and sends people back to choose. */
export function MunicipalityGone({ tenantId }: { tenantId: string }) {
  const { t } = usePreferences();
  const query = useJourneyQuery();
  const [favorite, setFavorite] = useFavorite();
  const wasFavorite = favorite === tenantId;
  useEffect(() => {
    if (wasFavorite) setFavorite(null);
  }, [wasFavorite, setFavorite]);
  return (
    <div className={styles.page}>
      <div className={styles.empty}>
        <p>
          {t(
            "Este municipio no está disponible.",
            "Este municipio non está dispoñible.",
          )}
        </p>
        <span>
          {wasFavorite
            ? t(
                "Era tu municipio favorito; lo hemos quitado. Elige otro para continuar.",
                "Era o teu municipio favorito; quitámolo. Escolle outro para continuar.",
              )
            : t(
                "Puede que el enlace haya cambiado. Elige un municipio para continuar.",
                "Pode que a ligazón cambiase. Escolle un municipio para continuar.",
              )}
        </span>
      </div>
      <LinkButton to={`${pickerPath}${query}`} variant="primary">
        {t("Elegir municipio", "Escoller municipio")}
      </LinkButton>
    </div>
  );
}

/** Second step: the facilities of one municipality. */
export function MunicipalityPage() {
  const { tenantId = "" } = useParams();
  const { locale, t } = usePreferences();
  const query = useJourneyQuery();
  const municipality = useMunicipality(tenantId);
  const facilities = useFacilities(tenantId);
  usePublicAppearance(tenantId);
  if (municipality.isPending) return <JourneyLoading />;
  if (municipality.isError)
    return missing(municipality.error) ? (
      <MunicipalityGone tenantId={tenantId} />
    ) : (
      <Failure
        error={municipality.error}
        retry={() => void municipality.refetch()}
      />
    );
  const name = municipality.data.name;
  const items = facilities.items.toSorted(
    (a, b) =>
      Number(b.units > 0) - Number(a.units > 0) ||
      a.name.localeCompare(b.name, locale),
  );
  const bookable = items.filter((item) => item.units > 0);
  // Covers are shown once any facility has a photo, so the list is either all images or none.
  const withPhotos = items.some((item) => item.photos?.length);
  const photoSource = publicPhotos(tenantId);
  return (
    <div className={styles.page}>
      <BookingSteps
        current={1}
        tenantId={tenantId}
        municipality={name}
        query={query}
      />
      <header className={styles.intro}>
        <p className={styles.context}>{name}</p>
        <h1 className={styles.title}>
          {t("Elige una instalación", "Escolle unha instalación")}
        </h1>
        <p className={styles.lead}>
          {t(
            "Cada instalación agrupa pistas, salas u otros espacios que se reservan por separado.",
            "Cada instalación agrupa pistas, salas ou outros espazos que se reservan por separado.",
          )}
        </p>
        <div className={styles.introActions}>
          <FavoriteToggle tenantId={tenantId} name={name} />
          <Link className={styles.textLink} to={`${pickerPath}${query}`}>
            {t("Cambiar municipio", "Cambiar municipio")}
          </Link>
        </div>
      </header>
      {facilities.isError ? (
        <Failure
          error={facilities.error}
          retry={() => void facilities.refetch()}
        />
      ) : facilities.loading ? (
        <Loading />
      ) : !bookable.length ? (
        <>
          <div className={styles.empty}>
            <p>
              {t(
                `${name} todavía no ofrece reservas en línea.`,
                `${name} aínda non ofrece reservas en liña.`,
              )}
            </p>
            <span>
              {t(
                "Cuando el ayuntamiento publique instalaciones aparecerán aquí. Puedes consultar otro municipio.",
                "Cando o concello publique instalacións aparecerán aquí. Podes consultar outro municipio.",
              )}
            </span>
          </div>
          <LinkButton to={`${pickerPath}${query}`}>
            {t("Elegir otro municipio", "Escoller outro municipio")}
          </LinkButton>
        </>
      ) : (
        <div className={styles.sections}>
          <Choices>
            {items.map((item) => (
              <Choice
                key={item.id}
                to={
                  item.units > 0
                    ? facilityPath(tenantId, item.id, query)
                    : undefined
                }
                title={item.name}
                media={
                  withPhotos && (
                    <PhotoThumb
                      photo={item.photos?.[0]}
                      source={photoSource}
                      icon={Building2}
                    />
                  )
                }
                meta={[
                  addressLine(item.profile),
                  item.units === 0
                    ? t(
                        "Sin espacios reservables por ahora",
                        "Sen espazos reservables polo de agora",
                      )
                    : item.units === 1
                      ? t("1 espacio reservable", "1 espazo reservable")
                      : t(
                          `${item.units} espacios reservables`,
                          `${item.units} espazos reservables`,
                        ),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
          </Choices>
          <aside className={styles.shortcut}>
            <Clock3 size={18} aria-hidden="true" />
            <div>
              <h2>
                {t("¿Te importa más la hora?", "Impórtache máis a hora?")}
              </h2>
              <p>
                {t(
                  "Busca los horarios libres de todas las instalaciones a la vez.",
                  "Busca os horarios libres de todas as instalacións á vez.",
                )}
              </p>
              <Link
                className={styles.textLink}
                to={searchPath(tenantId, query)}
              >
                {t("Buscar por día y hora", "Buscar por día e hora")}
              </Link>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Shortcut for people who start from the time: every facility of the municipality at once. */
export function SearchPage() {
  const { tenantId = "" } = useParams();
  const { t } = usePreferences();
  const query = useJourneyQuery();
  const municipality = useMunicipality(tenantId);
  usePublicAppearance(tenantId);
  if (municipality.isPending) return <Loading />;
  if (municipality.isError)
    return missing(municipality.error) ? (
      <MunicipalityGone tenantId={tenantId} />
    ) : (
      <Failure
        error={municipality.error}
        retry={() => void municipality.refetch()}
      />
    );
  return (
    <div className={styles.page}>
      <BackLink to={municipalityPath(tenantId, query)}>
        {t("Elegir por instalación", "Escoller por instalación")}
      </BackLink>
      <header className={styles.intro}>
        <p className={styles.context}>{municipality.data.name}</p>
        <h1 className={styles.title}>
          {t("Buscar por día y hora", "Buscar por día e hora")}
        </h1>
        <p className={styles.lead}>
          {t(
            "Elige el día y la duración para ver qué espacios quedan libres en todas las instalaciones.",
            "Escolle o día e a duración para ver que espazos quedan libres en todas as instalacións.",
          )}
        </p>
      </header>
      <AvailabilitySearch
        tenantId={tenantId}
        timeZone={municipality.data.timeZone}
      />
    </div>
  );
}
