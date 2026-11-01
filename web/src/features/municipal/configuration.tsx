import { useState } from "react";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { Textarea } from "../../ui/textarea/textarea";
import {
  emptyCalendar,
  minuteLabel,
  parseMinute,
  type UnitCalendar,
} from "./calendar-model";
import styles from "./municipal.module.css";
import resource from "./resource.module.css";
import {
  Denied,
  discardEditor,
  EditorRecovery,
  endpoint,
  MunicipalForm,
  Reason,
  useMunicipality,
  useMunicipalQuery,
} from "./shared";

interface Rules {
  version: number;
  text: string;
}
interface CalendarVersion {
  version: number;
  calendar: UnitCalendar;
}
export function RulesEditor({ path }: { path: string }) {
  const { t } = usePreferences();
  const q = useMunicipalQuery<Rules>(`${path}/usage-rules`, true);
  const [reset, setReset] = useState(0);
  return (
    <section className={styles.section}>
      <h2>{t("Normas de uso", "Normas de uso")}</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError && (q.data === undefined || discardEditor(q.error)) ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <EditorRecovery error={q.error} retry={() => void q.refetch()}>
            <RulesForm
              key={reset}
              path={path}
              initial={q.data ?? { version: 0, text: "" }}
            />
          </EditorRecovery>
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              const r = await q.refetch();
              if (r.isSuccess) setReset((v) => v + 1);
            }}
          >
            {t(
              "Descartar borrador y recargar normas",
              "Descartar borrador e recargar normas",
            )}
          </Button>
        </>
      )}
    </section>
  );
}
function RulesForm({ path, initial }: { path: string; initial: Rules }) {
  const { t } = usePreferences();
  const [version, setVersion] = useState(initial.version);
  const [text, setText] = useState(initial.text);
  return (
    <>
      <p className={styles.version}>
        {t("Versión", "Versión")} {version}
      </p>
      <MunicipalForm
        path={`${path}/usage-rules`}
        method="PUT"
        label={t("Guardar normas", "Gardar normas")}
        body={(d) => ({
          expectedVersion: version,
          text: text.trim(),
          reason: textField(d, "reason"),
        })}
        onSaved={(r) => setVersion((r as Rules).version)}
      >
        <Textarea
          label={t("Texto de las normas", "Texto das normas")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          maxLength={20000}
          rows={8}
        />
        <p>
          {t(
            "Se guarda una nueva versión. Las aceptaciones anteriores no se modifican.",
            "Gárdase unha nova versión. As aceptacións anteriores non se modifican.",
          )}
        </p>
        <Reason />
      </MunicipalForm>
    </>
  );
}
export function CalendarEditor({ path }: { path: string }) {
  const { t } = usePreferences();
  const q = useMunicipalQuery<CalendarVersion>(`${path}/calendar`, true);
  const [reset, setReset] = useState(0);
  return (
    <section className={styles.section}>
      <h2>{t("Horarios y excepciones", "Horarios e excepcións")}</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError && (q.data === undefined || discardEditor(q.error)) ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <EditorRecovery error={q.error} retry={() => void q.refetch()}>
            <CalendarForm
              key={reset}
              path={path}
              initial={q.data ?? { version: 0, calendar: emptyCalendar }}
            />
          </EditorRecovery>
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              const r = await q.refetch();
              if (r.isSuccess) setReset((v) => v + 1);
            }}
          >
            {t(
              "Descartar borrador y recargar horarios",
              "Descartar borrador e recargar horarios",
            )}
          </Button>
        </>
      )}
    </section>
  );
}
// Civil clock fields remain text until submit; invalid edits are never coerced to midnight.
interface Row {
  id: string;
  day: string;
  start: string;
  end: string;
  date: string;
  closed: boolean;
}
function CalendarForm({
  path,
  initial,
}: {
  path: string;
  initial: CalendarVersion;
}) {
  const { t } = usePreferences();
  const [version, setVersion] = useState(initial.version);
  const row = (v: Partial<Row>): Row => ({
    id: crypto.randomUUID(),
    day: "1",
    start: "09:00",
    end: "21:00",
    date: "",
    closed: false,
    ...v,
  });
  const [weekly, setWeekly] = useState(() =>
    initial.calendar.weekly.map((i) =>
      row({
        day: String(i.day),
        start: minuteLabel(i.startMinute),
        end: minuteLabel(i.endMinute),
      }),
    ),
  );
  const [exceptions, setExceptions] = useState(() =>
    initial.calendar.exceptions.flatMap((e) =>
      e.intervals.length
        ? e.intervals.map((i) =>
            row({
              date: e.date,
              start: minuteLabel(i.startMinute),
              end: minuteLabel(i.endMinute),
            }),
          )
        : [row({ date: e.date, closed: true })],
    ),
  );
  const days = [
    t("Lunes", "Luns"),
    t("Martes", "Martes"),
    t("Miércoles", "Mércores"),
    t("Jueves", "Xoves"),
    t("Viernes", "Venres"),
    t("Sábado", "Sábado"),
    t("Domingo", "Domingo"),
  ];
  const parse = (r: Row) => {
    const startMinute = parseMinute(r.start),
      endMinute = parseMinute(r.end, true);
    if (startMinute === null || endMinute === null || startMinute >= endMinute)
      throw new ApiError(
        400,
        "INVALID_INPUT",
        t(
          "Revisa las horas: inicio anterior al fin; 24:00 solo como fin.",
          "Revisa as horas: inicio anterior ao fin; 24:00 só como fin.",
        ),
      );
    return { startMinute, endMinute };
  };
  const rows = (values: Row[], set: (r: Row[]) => void, exception = false) =>
    values.map((r, index) => {
      const patch = (v: Partial<Row>) =>
        set(values.map((x) => (x.id === r.id ? { ...x, ...v } : x)));
      return (
        <fieldset key={r.id} className={styles.section}>
          <legend>
            {exception
              ? t("Excepción", "Excepción")
              : t("Franja semanal", "Franxa semanal")}{" "}
            {index + 1}
          </legend>
          <div className={styles.row}>
            {exception ? (
              <>
                <Input
                  type="date"
                  required
                  label={t("Fecha", "Data")}
                  value={r.date}
                  onChange={(e) => patch({ date: e.target.value })}
                />
                <Select
                  placeholder={t(
                    "Selecciona una opción",
                    "Selecciona unha opción",
                  )}
                  label={t("Apertura", "Apertura")}
                  value={r.closed ? "closed" : "open"}
                  options={[
                    { value: "open", label: t("Abierta", "Aberta") },
                    {
                      value: "closed",
                      label: t("Cerrada todo el día", "Pechada todo o día"),
                    },
                  ]}
                  onValueChange={(v) => patch({ closed: v === "closed" })}
                />
              </>
            ) : (
              <Select
                placeholder={t(
                  "Selecciona una opción",
                  "Selecciona unha opción",
                )}
                label={t("Día", "Día")}
                value={r.day}
                options={days.map((label, i) => ({
                  value: String(i + 1),
                  label,
                }))}
                onValueChange={(v) => patch({ day: v })}
              />
            )}
            {!r.closed && (
              <>
                <Input
                  required
                  label={t("Inicio (HH:mm)", "Inicio (HH:mm)")}
                  value={r.start}
                  onChange={(e) => patch({ start: e.target.value })}
                  pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                />
                <Input
                  required
                  label={t("Fin (HH:mm)", "Fin (HH:mm)")}
                  value={r.end}
                  onChange={(e) => patch({ end: e.target.value })}
                  pattern="(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)"
                />
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => set(values.filter((x) => x.id !== r.id))}
            >
              {t("Quitar franja", "Quitar franxa")} {index + 1}
            </Button>
          </div>
        </fieldset>
      );
    });
  return (
    <>
      <p className={styles.version}>
        {t("Versión", "Versión")} {version}
      </p>
      <MunicipalForm
        path={`${path}/calendar`}
        method="PUT"
        label={t("Guardar horarios", "Gardar horarios")}
        onSaved={(r) => setVersion((r as CalendarVersion).version)}
        body={(d) => {
          const grouped = new Map<
            string,
            {
              date: string;
              intervals: { startMinute: number; endMinute: number }[];
            }
          >();
          for (const r of exceptions) {
            const existing = grouped.get(r.date);
            if (existing && (!existing.intervals.length || r.closed))
              throw new ApiError(
                400,
                "INVALID_INPUT",
                t(
                  "Una fecha no puede estar cerrada y abierta a la vez.",
                  "Unha data non pode estar pechada e aberta á vez.",
                ),
              );
            const e = existing ?? { date: r.date, intervals: [] };
            if (!r.closed) e.intervals.push(parse(r));
            grouped.set(r.date, e);
          }
          return {
            expectedVersion: version,
            reason: textField(d, "reason"),
            calendar: {
              minimumMinutes: Number(d.get("min")),
              maximumMinutes: Number(d.get("max")),
              stepMinutes: Number(d.get("step")),
              advanceDays:
                textField(d, "advance") === ""
                  ? null
                  : Number(d.get("advance")),
              weekly: weekly.map((r) => ({ ...parse(r), day: Number(r.day) })),
              exceptions: [...grouped.values()],
            },
          };
        }}
      >
        <div className={resource.calendarParameters}>
          <Input
            label={t("Duración mínima (minutos)", "Duración mínima (minutos)")}
            name="min"
            type="number"
            min={1}
            required
            defaultValue={initial.calendar.minimumMinutes}
          />
          <Input
            label={t("Duración máxima (minutos)", "Duración máxima (minutos)")}
            name="max"
            type="number"
            min={1}
            required
            defaultValue={initial.calendar.maximumMinutes}
          />
          <Input
            label={t(
              "Paso de horarios (minutos)",
              "Paso de horarios (minutos)",
            )}
            name="step"
            type="number"
            min={1}
            required
            defaultValue={initial.calendar.stepMinutes}
          />
          <Input
            label={t(
              "Antelación de la unidad (días)",
              "Antelación da unidade (días)",
            )}
            description={t(
              "Vacío: utiliza el límite municipal.",
              "Baleiro: utiliza o límite municipal.",
            )}
            name="advance"
            type="number"
            min={0}
            defaultValue={initial.calendar.advanceDays ?? ""}
          />
        </div>
        <p>
          {t(
            "Horas locales del municipio. Las excepciones sustituyen los horarios semanales de su fecha; sin franjas, el día está cerrado.",
            "Horas locais do municipio. As excepcións substitúen os horarios semanais da súa data; sen franxas, o día está pechado.",
          )}
        </p>
        <h3 className={resource.subheading}>
          {t("Disponibilidad semanal", "Dispoñibilidade semanal")}
        </h3>
        {rows(weekly, setWeekly)}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setWeekly([...weekly, row({})])}
        >
          {t("Añadir franja semanal", "Engadir franxa semanal")}
        </Button>
        <h3 className={resource.subheading}>
          {t("Excepciones por fecha", "Excepcións por data")}
        </h3>
        {rows(exceptions, setExceptions, true)}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setExceptions([...exceptions, row({ closed: true })])}
        >
          {t("Añadir excepción", "Engadir excepción")}
        </Button>
        <Reason />
      </MunicipalForm>
    </>
  );
}
interface Policy {
  version: number;
  advanceDays: number;
  cancellationMinutes: number;
}
export function BookingPolicy() {
  const m = useMunicipality();
  if (!m.administrator) return <Denied />;
  return <PolicyEditor />;
}
function PolicyEditor() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const q = useMunicipalQuery<Policy>(`${endpoint(m.id)}/booking-policy`);
  const [reset, setReset] = useState(0);
  return (
    <>
      <h1>{t("Condiciones de reserva", "Condicións de reserva")}</h1>
      {q.isPending ? (
        <Loading />
      ) : q.isError && (q.data === undefined || discardEditor(q.error)) ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            <EditorRecovery error={q.error} retry={() => void q.refetch()}>
              <PolicyForm key={reset} initial={q.data} />
            </EditorRecovery>
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                const r = await q.refetch();
                if (r.isSuccess) setReset((x) => x + 1);
              }}
            >
              {t(
                "Descartar borrador y recargar",
                "Descartar borrador e recargar",
              )}
            </Button>
          </>
        )
      )}
    </>
  );
}
function PolicyForm({ initial }: { initial: Policy }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [version, setVersion] = useState(initial.version);
  return (
    <MunicipalForm
      path={`${endpoint(m.id)}/booking-policy`}
      method="PUT"
      label={t("Guardar condiciones", "Gardar condicións")}
      onSaved={(r) => setVersion((r as Policy).version)}
      body={(d) => ({
        expectedVersion: version,
        advanceDays: Number(d.get("advance")),
        cancellationMinutes: Number(d.get("cancellation")),
        reason: textField(d, "reason"),
      })}
    >
      <Input
        type="number"
        name="advance"
        label={t(
          "Antelación máxima (días naturales)",
          "Antelación máxima (días naturais)",
        )}
        min={0}
        required
        defaultValue={initial.advanceDays}
      />
      <Input
        type="number"
        name="cancellation"
        label={t(
          "Plazo de cancelación (minutos)",
          "Prazo de cancelación (minutos)",
        )}
        min={0}
        required
        defaultValue={initial.cancellationMinutes}
      />
      <p>
        {t(
          "24 horas son 1440 minutos. Las reservas existentes conservan el plazo aceptado.",
          "24 horas son 1440 minutos. As reservas existentes conservan o prazo aceptado.",
        )}
      </p>
      <Reason />
    </MunicipalForm>
  );
}
