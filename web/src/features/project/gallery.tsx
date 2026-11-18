import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useState } from "react";
import { usePreferences } from "../../app/preferences-provider";
import { motionTokens } from "../../ui/lib/motion-tokens";
import { useLiveReducedMotion } from "../../ui/lib/use-live-reduced-motion";
import SegmentedControl from "../../ui/segmented-control/segmented-control";
import type { Text } from "./content";
import styles from "./gallery.module.css";
import { useCapture } from "./media";

type Shot = { name: string; title: Text; summary: Text; points: Text[] };
type Group = "citizen" | "municipal" | "platform" | "mobile";

const groups: Record<
  Exclude<Group, "mobile">,
  { label: Text; shots: Shot[] }
> = {
  citizen: {
    label: ["Ciudadanía", "Cidadanía"],
    shots: [
      {
        name: "horarios",
        title: ["Elección de día y hora", "Escolla de día e hora"],
        summary: [
          "Cuarto paso de la reserva guiada, con el espacio ya elegido.",
          "Cuarto paso da reserva guiada, co espazo xa escollido.",
        ],
        points: [
          [
            "La barra superior indica el paso actual y las elecciones anteriores.",
            "A barra superior indica o paso actual e as escollas anteriores.",
          ],
          [
            "Solo se ofrecen los intervalos libres para la duración seleccionada.",
            "Só se ofrecen os intervalos libres para a duración seleccionada.",
          ],
          [
            "La fotografía y el nombre identifican el espacio sin ambigüedad.",
            "A fotografía e o nome identifican o espazo sen ambigüidade.",
          ],
        ],
      },
      {
        name: "buscar-por-hora",
        title: ["Búsqueda por día y hora", "Busca por día e hora"],
        summary: [
          "Horarios libres de todas las instalaciones del municipio en una sola vista.",
          "Horarios libres de todas as instalacións do concello nunha soa vista.",
        ],
        points: [
          [
            "Los resultados se agrupan por espacio.",
            "Os resultados agrúpanse por espazo.",
          ],
          [
            "El filtro de instalación permite acotar la búsqueda.",
            "O filtro de instalación permite acoutar a busca.",
          ],
        ],
      },
      {
        name: "reserva",
        title: ["Ficha de la reserva", "Ficha da reserva"],
        summary: [
          "Información completa de una reserva confirmada.",
          "Información completa dunha reserva confirmada.",
        ],
        points: [
          [
            "El código de acceso permite registrar la llegada en la instalación.",
            "O código de acceso permite rexistrar a chegada na instalación.",
          ],
          [
            "Se indica la fecha límite para cambiar o cancelar la reserva.",
            "Indícase a data límite para cambiar ou cancelar a reserva.",
          ],
          [
            "La reserva puede añadirse al calendario personal.",
            "A reserva pode engadirse ao calendario persoal.",
          ],
        ],
      },
      {
        name: "mis-reservas",
        title: ["Mis reservas", "As miñas reservas"],
        summary: [
          "Reservas de todos los municipios y horarios habituales de la persona.",
          "Reservas de todos os concellos e horarios habituais da persoa.",
        ],
        points: [
          [
            "Las sugerencias se calculan a partir de las reservas anteriores.",
            "As suxestións calcúlanse a partir das reservas anteriores.",
          ],
          [
            "Pueden desactivarse en cualquier momento.",
            "Pódense desactivar en calquera momento.",
          ],
        ],
      },
      {
        name: "avisos",
        title: ["Avisos", "Avisos"],
        summary: [
          "Registro de confirmaciones, modificaciones y cancelaciones.",
          "Rexistro de confirmacións, modificacións e cancelacións.",
        ],
        points: [
          [
            "Cada aviso enlaza con su reserva.",
            "Cada aviso lígase coa súa reserva.",
          ],
          [
            "Los avisos no leídos se distinguen de los leídos.",
            "Os avisos non lidos distínguense dos lidos.",
          ],
        ],
      },
    ],
  },
  municipal: {
    label: ["Ayuntamiento", "Concello"],
    shots: [
      {
        name: "uso",
        title: ["Uso de los espacios", "Uso dos espazos"],
        summary: [
          "Panel de indicadores del personal de gestión.",
          "Panel de indicadores do persoal de xestión.",
        ],
        points: [
          [
            "El periodo y el espacio se eligen en la parte superior.",
            "O período e o espazo escóllense na parte superior.",
          ],
          [
            "«Lo más destacado» resume en frases los cambios relevantes.",
            "«O máis destacado» resume en frases os cambios relevantes.",
          ],
          ["El resumen puede descargarse.", "O resumo pódese descargar."],
        ],
      },
      {
        name: "catalogo",
        title: ["Instalaciones y unidades", "Instalacións e unidades"],
        summary: [
          "Catálogo municipal con el estado de publicación de cada elemento.",
          "Catálogo municipal co estado de publicación de cada elemento.",
        ],
        points: [
          [
            "Cada instalación indica cuántas unidades reservables contiene.",
            "Cada instalación indica cantas unidades reservables contén.",
          ],
          [
            "Los borradores no son visibles para la ciudadanía hasta su publicación.",
            "Os borradores non son visibles para a cidadanía ata a súa publicación.",
          ],
        ],
      },
      {
        name: "personal",
        title: ["Personal y permisos", "Persoal e permisos"],
        summary: [
          "Administración de responsables, gestores e invitaciones.",
          "Administración de responsables, xestores e invitacións.",
        ],
        points: [
          [
            "Las pestañas separan administradores, gestores, invitaciones y retirada por seguridad.",
            "As lapelas separan administradores, xestores, invitacións e retirada por seguridade.",
          ],
          [
            "Cada permiso indica su estado y su vigencia.",
            "Cada permiso indica o seu estado e a súa vixencia.",
          ],
        ],
      },
      {
        name: "apariencia",
        title: ["Apariencia municipal", "Aparencia municipal"],
        summary: [
          "Nombre, logotipos y estilo visual del municipio.",
          "Nome, logotipos e estilo visual do concello.",
        ],
        points: [
          [
            "Se admite un logotipo distinto para el modo oscuro.",
            "Admítese un logotipo distinto para o modo escuro.",
          ],
          [
            "Los cambios se previsualizan antes de guardarse.",
            "Os cambios previsualízanse antes de gardarse.",
          ],
        ],
      },
    ],
  },
  platform: {
    label: ["Plataforma", "Plataforma"],
    shots: [
      {
        name: "plataforma",
        title: ["Operación de la plataforma", "Operación da plataforma"],
        summary: [
          "Espacio de trabajo de las personas que operan la instalación.",
          "Espazo de traballo das persoas que operan a instalación.",
        ],
        points: [
          [
            "El menú agrupa el acceso a la plataforma, los municipios y la instancia.",
            "O menú agrupa o acceso á plataforma, os concellos e a instancia.",
          ],
          [
            "El permiso de operador exige verificación en dos pasos reciente.",
            "O permiso de operador esixe verificación en dous pasos recente.",
          ],
        ],
      },
      {
        name: "municipio",
        title: [
          "Página pública de un municipio",
          "Páxina pública dun concello",
        ],
        summary: [
          "Vista ciudadana de un municipio con su identidad visual.",
          "Vista cidadá dun concello coa súa identidade visual.",
        ],
        points: [
          [
            "El logotipo del municipio aparece junto al de Quenda.",
            "O logotipo do concello aparece xunto ao de Quenda.",
          ],
          [
            "Las instalaciones sin espacios reservables se indican como tales.",
            "As instalacións sen espazos reservables indícanse como tales.",
          ],
        ],
      },
    ],
  },
};

const phones: Shot[] = [
  {
    name: "movil-instalaciones",
    title: ["Instalaciones", "Instalacións"],
    summary: [
      "Elección de instalación con fotografía.",
      "Escolla de instalación con fotografía.",
    ],
    points: [],
  },
  {
    name: "movil-horarios",
    title: ["Horarios libres", "Horarios libres"],
    summary: [
      "Intervalos dispuestos para la pulsación táctil.",
      "Intervalos dispostos para a pulsación táctil.",
    ],
    points: [],
  },
  {
    name: "movil-mis-reservas",
    title: ["Mis reservas", "As miñas reservas"],
    summary: [
      "Horarios habituales y reserva directa.",
      "Horarios habituais e reserva directa.",
    ],
    points: [],
  },
];

const order: Group[] = ["citizen", "municipal", "platform", "mobile"];
const enter = [...motionTokens.ease.enter] as [number, number, number, number];

/** Views of the application by audience, each with what it shows; the mobile tab shows the phone layout. */
export function Gallery() {
  const { t } = usePreferences();
  const capture = useCapture();
  const reduced = useLiveReducedMotion();
  const [group, setGroup] = useState<Group>("citizen");
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const tx = (text: Text) => t(text[0], text[1]);
  const labels: Record<Group, string> = {
    citizen: tx(groups.citizen.label),
    municipal: tx(groups.municipal.label),
    platform: tx(groups.platform.label),
    mobile: t("Móvil", "Móbil"),
  };
  const shots = group === "mobile" ? [] : groups[group].shots;
  const shot = shots[Math.min(index, shots.length - 1)];
  const step = (delta: number) =>
    setIndex((current) => (current + delta + shots.length) % shots.length);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") step(1);
    if (event.key === "ArrowLeft") step(-1);
  };
  const fade = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0 },
    transition: {
      duration: reduced ? 0 : motionTokens.duration.considered,
      ease: enter,
    },
  };

  return (
    <div className={styles.gallery}>
      <SegmentedControl
        className={styles.tabs}
        label={t("Vistas de la aplicación", "Vistas da aplicación")}
        options={order.map((value) => ({ value, label: labels[value] }))}
        value={group}
        onValueChange={(value) => {
          setGroup(value as Group);
          setIndex(0);
        }}
      />

      {group === "mobile" ? (
        <motion.ul key="mobile" className={styles.phones} {...fade}>
          {phones.map((phone) => (
            <li key={phone.name}>
              <div className={styles.phone}>
                <img
                  src={capture(phone.name)}
                  alt={tx(phone.summary)}
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <strong>{tx(phone.title)}</strong>
              <span>{tx(phone.summary)}</span>
            </li>
          ))}
        </motion.ul>
      ) : (
        shot && (
          <div className={styles.viewer}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${group}-${shot.name}`}
                className={styles.stage}
                {...fade}
              >
                <button
                  type="button"
                  className={styles.shot}
                  onClick={() => setOpen(true)}
                  aria-label={`${t("Ampliar", "Ampliar")}: ${tx(shot.title)}`}
                >
                  <img
                    src={capture(shot.name)}
                    alt={tx(shot.summary)}
                    decoding="async"
                  />
                  <span className={styles.expand} aria-hidden="true">
                    <Maximize2 size={15} />
                  </span>
                </button>
                <div className={styles.panel}>
                  <p className={styles.counter}>
                    {index + 1} / {shots.length}
                  </p>
                  <h3>{tx(shot.title)}</h3>
                  <p className={styles.summary}>{tx(shot.summary)}</p>
                  <p className={styles.pointsTitle}>
                    {t("Aspectos destacados", "Aspectos destacados")}
                  </p>
                  <ul className={styles.points}>
                    {shot.points.map((point) => (
                      <li key={point[0]}>{tx(point)}</li>
                    ))}
                  </ul>
                  {shots.length > 1 && (
                    <div className={styles.controls}>
                      <button
                        type="button"
                        onClick={() => step(-1)}
                        aria-label={t("Vista anterior", "Vista anterior")}
                      >
                        <ChevronLeft size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => step(1)}
                        aria-label={t("Vista siguiente", "Vista seguinte")}
                      >
                        <ChevronRight size={18} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
            {shots.length > 1 && (
              <ul
                className={styles.thumbs}
                aria-label={t("Vistas", "Vistas")}
                onKeyDown={onKey}
              >
                {shots.map((item, position) => (
                  <li key={item.name}>
                    <button
                      type="button"
                      className={styles.thumb}
                      aria-pressed={position === index}
                      onClick={() => setIndex(position)}
                    >
                      <img
                        src={capture(item.name)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <span>{tx(item.title)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      )}

      {shot && (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className={styles.backdrop} />
            <Dialog.Content
              className={styles.dialog}
              onKeyDown={onKey}
              aria-describedby={undefined}
            >
              <div className={styles.dialogBar}>
                <Dialog.Title className={styles.dialogTitle}>
                  {tx(shot.title)}
                </Dialog.Title>
                <span className={styles.dialogCount}>
                  {index + 1} / {shots.length}
                </span>
                <Dialog.Close
                  className={styles.dialogButton}
                  aria-label={t("Cerrar", "Pechar")}
                >
                  <X size={18} />
                </Dialog.Close>
              </div>
              <div className={styles.dialogImage}>
                <img src={capture(shot.name)} alt={tx(shot.summary)} />
              </div>
              <div className={styles.dialogNav}>
                <button
                  type="button"
                  className={styles.dialogButton}
                  onClick={() => step(-1)}
                  aria-label={t("Vista anterior", "Vista anterior")}
                >
                  <ChevronLeft size={18} />
                </button>
                <p>{tx(shot.summary)}</p>
                <button
                  type="button"
                  className={styles.dialogButton}
                  onClick={() => step(1)}
                  aria-label={t("Vista siguiente", "Vista seguinte")}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}
