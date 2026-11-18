import {
  Building2,
  CalendarCheck,
  CircleUserRound,
  Clock3,
  LandPlot,
  MapPin,
  Plus,
} from "lucide-react";
import { motion } from "motion/react";
import { usePreferences } from "../../app/preferences-provider";
import { motionTokens } from "../../ui/lib/motion-tokens";
import { useLiveReducedMotion } from "../../ui/lib/use-live-reduced-motion";
import styles from "./project.module.css";

const enter = [...motionTokens.ease.enter] as [number, number, number, number];

/** The five booking steps on a line that fills in as it scrolls into view. */
export function BookingFlow() {
  const { t } = usePreferences();
  const reduced = useLiveReducedMotion();
  const steps = [
    {
      icon: MapPin,
      label: t("Municipio", "Concello"),
      detail: t("Lugar de la reserva", "Lugar da reserva"),
    },
    {
      icon: Building2,
      label: t("Instalación", "Instalación"),
      detail: t("Pabellón o complejo", "Pavillón ou complexo"),
    },
    {
      icon: LandPlot,
      label: t("Espacio", "Espazo"),
      detail: t("Pista, sala o campo", "Pista, sala ou campo"),
    },
    {
      icon: Clock3,
      label: t("Día y hora", "Día e hora"),
      detail: t("Solo intervalos libres", "Só intervalos libres"),
    },
    {
      icon: CalendarCheck,
      label: t("Confirmación", "Confirmación"),
      detail: t("Normas aceptadas y código QR", "Normas aceptadas e código QR"),
    },
  ];
  return (
    <ol
      className={styles.flow}
      aria-label={t("Pasos de una reserva", "Pasos dunha reserva")}
    >
      <motion.span
        className={styles.flowLine}
        aria-hidden="true"
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 1.4, ease: enter }}
      />
      {steps.map(({ icon: Icon, label, detail }, index) => (
        <motion.li
          key={label}
          className={styles.flowStep}
          initial={reduced ? false : { opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{
            duration: 0.5,
            ease: enter,
            delay: reduced ? 0 : 0.15 + index * 0.18,
          }}
        >
          <span className={styles.flowDot}>
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className={styles.flowNumber}>{index + 1}</span>
          <strong>{label}</strong>
          <span>{detail}</span>
        </motion.li>
      ))}
    </ol>
  );
}

/** One deployment serving several municipalities, each with its own data, and one account per resident. */
export function Tenancy() {
  const { t } = usePreferences();
  const reduced = useLiveReducedMotion();
  const towns = [
    {
      name: "Concello de Valdeira",
      detail: t("2 instalaciones · 6 espacios", "2 instalacións · 6 espazos"),
    },
    {
      name: "Ribasanta do Mar",
      detail: t("2 instalaciones · 1 espacio", "2 instalacións · 1 espazo"),
    },
  ];
  return (
    <figure className={styles.tenancy}>
      <div className={styles.tenancyInstance}>
        <span className={styles.label}>
          {t("Instalación de Quenda", "Instalación de Quenda")}
        </span>
        <div className={styles.tenancyTowns}>
          {towns.map((town, index) => (
            <motion.div
              key={town.name}
              className={styles.town}
              initial={reduced ? false : { opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{
                duration: 0.5,
                ease: enter,
                delay: reduced ? 0 : index * 0.12,
              }}
            >
              <Building2 size={18} strokeWidth={1.75} aria-hidden="true" />
              <strong>{town.name}</strong>
              <span>{town.detail}</span>
              <span className={styles.townNote}>
                {t(
                  "Datos, permisos y apariencia propios",
                  "Datos, permisos e aparencia propios",
                )}
              </span>
            </motion.div>
          ))}
          <div className={styles.town} data-new="">
            <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
            <strong>{t("Nuevo municipio", "Novo concello")}</strong>
            <span>
              {t(
                "Alta por la operación de la plataforma",
                "Alta pola operación da plataforma",
              )}
            </span>
          </div>
        </div>
        <div className={styles.tenancyAccount}>
          <CircleUserRound size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>
            <strong>{t("Cuenta ciudadana única", "Conta cidadá única")}</strong>
            {t(
              ". La misma identidad y el mismo historial sirven en todos los municipios.",
              ". A mesma identidade e o mesmo historial serven en todos os concellos.",
            )}
          </span>
        </div>
      </div>
      <figcaption>
        {t(
          "Los municipios del ejemplo son los ficticios de la demostración.",
          "Os concellos do exemplo son os ficticios da demostración.",
        )}
      </figcaption>
    </figure>
  );
}
