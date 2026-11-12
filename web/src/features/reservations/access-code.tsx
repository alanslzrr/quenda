import { CalendarDays, ChevronRight, Clock3, MapPin } from "lucide-react";
import { usePreferences } from "../../app/preferences-provider";
import { Dialog, DialogContent, DialogTrigger } from "../../ui/dialog/dialog";
import { calendarLabel } from "../../ui/lib/calendar-labels";
import {
  calendarDate,
  durationLabel,
  municipalToday,
  timeRange,
} from "../catalog/dates";
import { accessCodeModules } from "./access-code-model";
import styles from "./reservations.module.css";

/**
 * A QR code drawn as one SVG path. Dark modules on a white field with the
 * standard quiet zone, whatever the theme, so phone cameras can read it.
 */
export function AccessCode({
  value,
  label,
  decorative = false,
}: {
  value: string;
  label: string;
  decorative?: boolean;
}) {
  const { data, size } = accessCodeModules(value);
  let path = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  const box = `0 0 ${size} ${size}`;
  const modules = <path d={path} fill="#000" />;
  return decorative ? (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={box}
      shapeRendering="crispEdges"
      className={styles.accessCode}
    >
      {modules}
    </svg>
  ) : (
    <svg
      role="img"
      aria-label={label}
      viewBox={box}
      shapeRendering="crispEdges"
      className={styles.accessCode}
    >
      {modules}
    </svg>
  );
}

/**
 * The access code is shown when the holder needs it: a card on the
 * reservation opens a dialog with the code large enough to scan and the
 * details staff check against it.
 */
export function AccessPass({
  value,
  unitName,
  context,
  startsAt,
  endsAt,
  timeZone,
  reference,
}: {
  value: string;
  unitName: string;
  context: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  reference: string;
}) {
  const { locale, t } = usePreferences();
  const day = calendarLabel(
    calendarDate(municipalToday(timeZone, new Date(startsAt))),
    locale,
    "full",
  );
  const minutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60000;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={styles.accessCard}>
          <span className={styles.accessThumb}>
            <AccessCode value={value} label="" decorative />
          </span>
          <span className={styles.accessText}>
            <span className={styles.accessTitle}>
              {t("Ver código de acceso", "Ver código de acceso")}
            </span>
            <span className={styles.accessMeta}>
              {t(
                "Muéstralo al llegar para registrar tu entrada.",
                "Amósao ao chegar para rexistrar a túa entrada.",
              )}
            </span>
          </span>
          <ChevronRight
            size={18}
            aria-hidden="true"
            className={styles.accessChevron}
          />
        </button>
      </DialogTrigger>
      <DialogContent
        closeLabel={t("Cerrar", "Pechar")}
        title={t("Código de acceso", "Código de acceso")}
        description={t(
          "El personal lo escanea con su teléfono para comprobar la reserva.",
          "O persoal escanéao co seu teléfono para comprobar a reserva.",
        )}
      >
        <div className={styles.pass}>
          <div className={styles.passCode}>
            <AccessCode
              value={value}
              label={t(
                "Código QR de acceso de esta reserva",
                "Código QR de acceso desta reserva",
              )}
            />
          </div>
          <div className={styles.passDetails}>
            <p className={styles.passUnit}>{unitName}</p>
            <dl className={styles.passFacts}>
              {context && (
                <div>
                  <MapPin size={16} aria-hidden="true" />
                  <dt>{t("Lugar", "Lugar")}</dt>
                  <dd>{context}</dd>
                </div>
              )}
              <div>
                <CalendarDays size={16} aria-hidden="true" />
                <dt>{t("Fecha", "Data")}</dt>
                <dd>{day}</dd>
              </div>
              <div>
                <Clock3 size={16} aria-hidden="true" />
                <dt>{t("Horario", "Horario")}</dt>
                <dd>
                  {timeRange(startsAt, endsAt, timeZone, locale)}
                  <span> · {durationLabel(minutes)}</span>
                </dd>
              </div>
            </dl>
            <p className={styles.passReference}>
              {t("Referencia", "Referencia")}{" "}
              <code>{reference.slice(0, 8).toUpperCase()}</code>
            </p>
          </div>
          <p className={styles.passHint}>
            {t(
              "Si no se lee a la primera, sube el brillo de la pantalla.",
              "Se non se le á primeira, sube o brillo da pantalla.",
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
