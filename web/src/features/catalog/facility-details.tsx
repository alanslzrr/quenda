import { usePreferences } from "../../app/preferences-provider";
import styles from "./booking.module.css";
import {
  addressLine,
  type FacilityProfile,
  localized,
  mapLink,
} from "./profile";

/** What a citizen needs to choose and reach a facility. Absent fields are simply not shown. */
export function FacilityDetails({ profile }: { profile?: FacilityProfile }) {
  const { locale, t } = usePreferences();
  if (!profile) return null;
  const address = addressLine(profile);
  const description = localized(profile.description, locale);
  const accessibility = localized(profile.accessibility, locale);
  const phone = profile.contact?.phone;
  const email = profile.contact?.email;
  if (!address && !description && !accessibility && !phone && !email)
    return null;
  return (
    <dl className={styles.details}>
      {description && (
        <div className={styles.detail}>
          <dt>{t("Descripción", "Descrición")}</dt>
          <dd>{description}</dd>
        </div>
      )}
      {address && (
        <div className={styles.detail}>
          <dt>{t("Dirección", "Enderezo")}</dt>
          <dd>
            {address}
            {profile.location && (
              <>
                {" · "}
                <a
                  href={mapLink(profile.location)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t(
                    "Cómo llegar (se abre en otra pestaña)",
                    "Como chegar (ábrese noutra lapela)",
                  )}
                </a>
              </>
            )}
          </dd>
        </div>
      )}
      {accessibility && (
        <div className={styles.detail}>
          <dt>{t("Accesibilidad", "Accesibilidade")}</dt>
          <dd>{accessibility}</dd>
        </div>
      )}
      {(phone || email) && (
        <div className={styles.detail}>
          <dt>{t("Contacto", "Contacto")}</dt>
          <dd>
            {phone && (
              <a href={`tel:${phone.replaceAll(/[^0-9+]/g, "")}`}>{phone}</a>
            )}
            {phone && email && " · "}
            {email && <a href={`mailto:${email}`}>{email}</a>}
          </dd>
        </div>
      )}
    </dl>
  );
}
