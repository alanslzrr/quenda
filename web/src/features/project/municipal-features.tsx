import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { motionTokens } from "../../ui/lib/motion-tokens";
import { useLiveReducedMotion } from "../../ui/lib/use-live-reduced-motion";
import type { Text } from "./content";
import { useCapture } from "./media";
import styles from "./municipal-features.module.css";

type Feature = { capture: string; title: Text; text: Text };

const features: Feature[] = [
  {
    capture: "detalle-resumen",
    title: ["Indicadores del periodo", "Indicadores do período"],
    text: [
      "Ocupación, horas reservadas, reservas, cancelaciones y llegadas registradas, con la variación respecto al periodo anterior.",
      "Ocupación, horas reservadas, reservas, cancelacións e chegadas rexistradas, coa variación respecto ao período anterior.",
    ],
  },
  {
    capture: "detalle-evolucion",
    title: ["Evolución de la ocupación", "Evolución da ocupación"],
    text: [
      "Ocupación diaria comparada con el periodo anterior. Cada gráfico dispone de una tabla equivalente.",
      "Ocupación diaria comparada co período anterior. Cada gráfico dispón dunha táboa equivalente.",
    ],
  },
  {
    capture: "detalle-demanda",
    title: ["Demanda por franja horaria", "Demanda por franxa horaria"],
    text: [
      "Ocupación por día de la semana y hora, útil para ajustar los horarios ofertados.",
      "Ocupación por día da semana e hora, útil para axustar os horarios ofertados.",
    ],
  },
  {
    capture: "detalle-catalogo",
    title: ["Catálogo de instalaciones", "Catálogo de instalacións"],
    text: [
      "Instalaciones y unidades reservables con su estado de publicación. Los cambios se preparan como borrador.",
      "Instalacións e unidades reservables co seu estado de publicación. Os cambios prepáranse como borrador.",
    ],
  },
  {
    capture: "detalle-personal",
    title: ["Personal y permisos", "Persoal e permisos"],
    text: [
      "Responsables, gestores e invitaciones por correo electrónico, con caducidad y retirada inmediata.",
      "Responsables, xestores e invitacións por correo electrónico, con caducidade e retirada inmediata.",
    ],
  },
  {
    capture: "detalle-identidad",
    title: ["Identidad del municipio", "Identidade do concello"],
    text: [
      "Nombre visible y logotipos para fondo claro y oscuro, aplicados a la página pública y a la gestión.",
      "Nome visible e logotipos para fondo claro e escuro, aplicados á páxina pública e á xestión.",
    ],
  },
];

const enter = [...motionTokens.ease.enter] as [number, number, number, number];

/** Municipal tools as tabs: the list on one side, a legible crop of the real screen on the other. */
export function MunicipalFeatures() {
  const { t } = usePreferences();
  const capture = useCapture();
  const reduced = useLiveReducedMotion();
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const tx = (text: Text) => t(text[0], text[1]);
  const current = features[active] as Feature;

  const onKey = (event: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    const delta = keys[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = (active + delta + features.length) % features.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const image = (feature: Feature) => (
    <img
      src={capture(feature.capture)}
      alt={tx(feature.text)}
      decoding="async"
      loading="lazy"
    />
  );

  return (
    <div className={styles.features}>
      <LayoutGroup id={id}>
        <div
          className={styles.list}
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("Herramientas municipales", "Ferramentas municipais")}
          onKeyDown={onKey}
        >
          {features.map((feature, index) => {
            const selected = index === active;
            return (
              <div key={feature.capture} className={styles.item}>
                <button
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${index}`}
                  aria-selected={selected}
                  aria-controls={`${id}-panel`}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tab}
                  onClick={() => setActive(index)}
                >
                  {selected && (
                    <motion.span
                      layoutId="active"
                      className={styles.highlight}
                      transition={
                        reduced ? { duration: 0 } : motionTokens.spring.morph
                      }
                      aria-hidden="true"
                    />
                  )}
                  <span className={styles.tabTitle}>{tx(feature.title)}</span>
                  <span className={styles.tabText}>{tx(feature.text)}</span>
                </button>
                {selected && (
                  <div className={styles.inline}>{image(feature)}</div>
                )}
              </div>
            );
          })}
        </div>
      </LayoutGroup>
      <div
        className={styles.panel}
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.capture}
            className={styles.frame}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: reduced ? 0 : motionTokens.duration.considered,
              ease: enter,
            }}
          >
            {image(current)}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
