import { usePreferences } from "../../app/preferences-provider";
import video from "./presentacion.mp4";
import poster from "./presentacion-poster.webp";
import styles from "./presentation.module.css";

/**
 * The two-minute presentation recorded on the application with the demo data. It loads only when played; the
 * README carries the full-resolution original, this is a 720p encode for the page.
 */
export function Presentation() {
  const { t } = usePreferences();
  return (
    <figure id="presentacion" className={styles.presentation}>
      <div className={styles.frame}>
        {/* biome-ignore lint/a11y/useMediaCaption: the presentation has music and on-screen text, no speech. */}
        <video
          className={styles.video}
          src={video}
          poster={poster}
          controls
          preload="none"
          playsInline
          aria-describedby="presentacion-descripcion"
        />
      </div>
      <figcaption id="presentacion-descripcion" className={styles.caption}>
        <strong>{t("Presentación de Quenda", "Presentación de Quenda")}</strong>
        <span>
          {t(
            "Recorrido de dos minutos grabado sobre la aplicación con los datos de la demostración: reserva ciudadana con código de acceso, agenda y analítica municipal, condiciones, horarios y permisos, identidad de cada municipio y modelos de despliegue. El vídeo contiene música y texto en pantalla, sin narración.",
            "Percorrido de dous minutos gravado sobre a aplicación cos datos da demostración: reserva cidadá con código de acceso, axenda e analítica municipal, condicións, horarios e permisos, identidade de cada concello e modelos de despregamento. O vídeo contén música e texto en pantalla, sen narración.",
          )}
        </span>
      </figcaption>
    </figure>
  );
}
