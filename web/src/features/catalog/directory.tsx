import { useState } from "react";
import { useFavorite } from "../../app/favorite";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Input } from "../../ui/input/input";
import { compareText } from "../../ui/lib/intl-cache.ts";
import styles from "./booking.module.css";
import {
  BookingSteps,
  Choice,
  Choices,
  FavoriteBadge,
  FavoriteToggle,
  municipalityPath,
  useJourneyQuery,
  useMunicipalities,
} from "./journey";

const searchable = 8;

/** First step of a booking: the municipality, with the favourite offered first and every other one still in reach. */
export function Home() {
  useMunicipalTheme(undefined);
  const { locale, t } = usePreferences();
  const [favorite] = useFavorite();
  const [filter, setFilter] = useState("");
  const query = useJourneyQuery();
  const municipalities = useMunicipalities();
  const items = municipalities.items.toSorted((a, b) =>
    compareText(a.name, b.name, locale),
  );
  const chosen = items.find((item) => item.id === favorite);
  const needle = filter.trim().toLocaleLowerCase(locale);
  const others = items.filter(
    (item) =>
      item.id !== chosen?.id &&
      (!needle || item.name.toLocaleLowerCase(locale).includes(needle)),
  );
  const row = (item: (typeof items)[number], mine = false) => (
    <Choice
      key={item.id}
      to={municipalityPath(item.id, query)}
      title={item.name}
      badge={mine ? <FavoriteBadge /> : undefined}
      aside={<FavoriteToggle tenantId={item.id} name={item.name} compact />}
    />
  );
  return (
    <div className={styles.page}>
      <BookingSteps current={0} />
      <header className={styles.intro}>
        <h1 className={styles.title}>
          {t("¿Dónde quieres reservar?", "Onde queres reservar?")}
        </h1>
        <p className={styles.lead}>
          {t(
            "Elige el municipio para ver sus instalaciones deportivas. Marca uno como favorito y la próxima vez empezarás ahí.",
            "Escolle o municipio para ver as súas instalacións deportivas. Marca un como favorito e a próxima vez comezarás aí.",
          )}
        </p>
      </header>
      {municipalities.isError ? (
        <Failure
          error={municipalities.error}
          retry={() => void municipalities.refetch()}
        />
      ) : municipalities.loading ? (
        <Loading />
      ) : !items.length ? (
        <div className={styles.empty}>
          <p>
            {t(
              "Todavía no hay municipios con reserva en línea.",
              "Aínda non hai municipios con reserva en liña.",
            )}
          </p>
        </div>
      ) : (
        <div className={styles.sections}>
          {chosen && (
            <section aria-labelledby="favorite-heading">
              <h2 id="favorite-heading" className={styles.sectionTitle}>
                {t("Tu municipio favorito", "O teu municipio favorito")}
              </h2>
              <Choices>{row(chosen, true)}</Choices>
            </section>
          )}
          <section aria-labelledby="municipalities-heading">
            <h2 id="municipalities-heading" className={styles.sectionTitle}>
              {chosen
                ? t("Otros municipios", "Outros municipios")
                : t("Municipios", "Municipios")}
            </h2>
            {items.length > searchable && (
              <div className={styles.filter}>
                <Input
                  label={t("Buscar municipio", "Buscar municipio")}
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            )}
            {others.length ? (
              <Choices>{others.map((item) => row(item))}</Choices>
            ) : (
              <p className={styles.quiet} role="status">
                {needle
                  ? t(
                      "Ningún municipio coincide con la búsqueda.",
                      "Ningún municipio coincide coa busca.",
                    )
                  : t(
                      "No hay más municipios en esta instancia.",
                      "Non hai máis municipios nesta instancia.",
                    )}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
