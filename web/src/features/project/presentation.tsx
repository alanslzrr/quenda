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
    <div id="presentacion" className={styles.presentation}>
      <div className={styles.frame}>
        {/* biome-ignore lint/a11y/useMediaCaption: the presentation has music and on-screen text, no speech. */}
        <video
          className={styles.video}
          src={video}
          poster={poster}
          controls
          preload="none"
          playsInline
          aria-label={t("Presentación de Quenda", "Presentación de Quenda")}
        />
      </div>
    </div>
  );
}
