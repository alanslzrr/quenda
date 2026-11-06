import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ActionForm, textField } from "../../app/action";
import { api, type Municipality } from "../../app/api";
import { Disclosure } from "../../app/disclosure";
import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { useSession } from "../../app/session";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import { municipalToday } from "../catalog/dates";
import type { Availability, Unit } from "../catalog/unit";
import {
  type CommandPolicy,
  commandResultPath,
  readCommand,
  sendCommand,
} from "../reservations/commands";
import {
  dateTime,
  PendingLink,
  type Reservation,
  ReservationSummary,
} from "../reservations/shared";
import { localInstants } from "./local-instants";
import styles from "./municipal.module.css";
import {
  Denied,
  endpoint,
  More,
  municipalPath,
  permitted,
  Reason,
  useMunicipality,
  useMunicipalPages,
  useMunicipalQuery,
} from "./shared";

type PlanningUnit = { id: string; name: string };
type Block = {
  id: string;
  unitId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  releasedAt: string | null;
};
export function Agenda() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const canPlan =
    m.administrator ||
    m.permissions.some((p) =>
      ["RESERVATION_READ", "RESERVATION_MANAGE", "UNIT_BLOCK"].includes(
        p.operation,
      ),
    );
  if (!canPlan) return <Denied />;
  return (
    <>
      <h1>{t("Agenda diaria", "Axenda diaria")}</h1>
      <AgendaData />
    </>
  );
}
function AgendaData() {
  const m = useMunicipality();
  const q = useMunicipalQuery<Municipality>(
    `/api/public/municipalities/${m.id}`,
  );
  const units = useMunicipalPages<PlanningUnit>(
    `${endpoint(m.id)}/agenda/units`,
  );
  // The unit directory is a short id/name list that every selector and row label needs, so load it whole.
  const { hasNextPage, isFetching, isError, fetchNextPage } = units;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  if (q.isPending || units.isPending) return <Loading />;
  const retry = () => {
    if (q.isError) void q.refetch();
    if (units.isError) void units.refetch();
  };
  if (blocksEditor(q) || blocksEditor(units) || !q.data || !units.data)
    return <Failure error={q.error ?? units.error} retry={retry} />;
  return (
    <EditorRecovery
      error={q.isError ? q.error : units.isError ? units.error : null}
      retry={retry}
    >
      <AgendaDay
        timeZone={q.data.timeZone}
        units={units.data.pages.flatMap((p) => p.items)}
      />
      {units.isError && <More query={units} />}
    </EditorRecovery>
  );
}
function AgendaDay({
  timeZone,
  units,
}: {
  timeZone: string;
  units: PlanningUnit[];
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [date, setDate] = useState(() => municipalToday(timeZone));
  const [unitId, setUnit] = useState("all");
  const filter = `?date=${date}${unitId === "all" ? "" : `&unitId=${unitId}`}`;
  const names = new Map(units.map((u) => [u.id, u.name]));
  const canRead =
    m.administrator ||
    m.permissions.some((p) =>
      ["RESERVATION_READ", "RESERVATION_MANAGE"].includes(p.operation),
    );
  const canBlock =
    m.administrator || m.permissions.some((p) => p.operation === "UNIT_BLOCK");
  return (
    <>
      <p>
        {t("Horas del municipio:", "Horas do municipio:")} {timeZone}
      </p>
      <div className={styles.row}>
        <Input
          type="date"
          label={t("Fecha de la agenda", "Data da axenda")}
          value={date}
          required
          onChange={(e) => setDate(e.target.value)}
        />
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          label={t("Unidad", "Unidade")}
          value={unitId}
          onValueChange={setUnit}
          options={[
            {
              value: "all",
              label: t("Todas las autorizadas", "Todas as autorizadas"),
            },
            ...units.map((u) => ({ value: u.id, label: u.name })),
          ]}
        />
      </div>
      <PendingLink />
      {/^\d{4}-\d{2}-\d{2}$/.test(date) && (
        <>
          {canRead && (
            <ReservationList
              key={`reservations:${filter}`}
              path={`${endpoint(m.id)}/reservations${filter}`}
              names={names}
            />
          )}
          {canBlock && (
            <BlockList
              key={`blocks:${filter}`}
              path={`${endpoint(m.id)}/blocks${filter}`}
              names={names}
              timeZone={timeZone}
            />
          )}
        </>
      )}
      {canBlock && (
        <section className={styles.section}>
          <h2>{t("Nuevo bloqueo", "Novo bloqueo")}</h2>
          <CreateBlock
            timeZone={timeZone}
            units={units.filter((u) => permitted(m, "UNIT_BLOCK", u.id))}
          />
        </section>
      )}
      <p className={styles.version}>
        {t(
          "Las páginas se ordenan por identificador. Carga las restantes para consultar todas las entradas del día.",
          "As páxinas ordénanse por identificador. Carga as restantes para consultar todas as entradas do día.",
        )}
      </p>
    </>
  );
}
function ReservationList({
  path,
  names,
}: {
  path: string;
  names: Map<string, string>;
}) {
  const m = useMunicipality();
  const { locale, t } = usePreferences();
  const q = useMunicipalPages<Reservation>(path);
  return (
    <section className={styles.section}>
      <h2>{t("Reservas", "Reservas")}</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <SortableDataTable
            caption={t("Reservas del día", "Reservas do día")}
            rows={q.data.pages.flatMap((p) => p.items).map((r) => ({ ...r }))}
            rowKey="id"
            emptyMessage={t(
              "No hay reservas para este día y ámbito.",
              "Non hai reservas para este día e ámbito.",
            )}
            columns={[
              {
                key: "startsAt",
                sortable: false,
                label: t("Inicio", "Inicio"),
                render: (_, r) => (
                  <Link to={`${municipalPath(m.id)}/reservas/${r.id}`}>
                    {dateTime(r.startsAt, r.timeZone, locale)}
                  </Link>
                ),
              },
              {
                key: "endsAt",
                sortable: false,
                label: t("Fin", "Fin"),
                render: (_, r) => dateTime(r.endsAt, r.timeZone, locale),
              },
              {
                key: "unitId",
                sortable: false,
                label: t("Unidad", "Unidade"),
                render: (_, r) => names.get(r.unitId) ?? r.unitId,
              },
              {
                key: "status",
                sortable: false,
                label: t("Estado", "Estado"),
                render: (_, r) =>
                  r.status === "CONFIRMADA"
                    ? t("Confirmada", "Confirmada")
                    : r.status === "CANCELADA"
                      ? t("Cancelada", "Cancelada")
                      : t("Finalizada", "Finalizada"),
              },
            ]}
          />
          <More query={q} />
        </>
      )}
    </section>
  );
}
function BlockList({
  path,
  names,
  timeZone,
}: {
  path: string;
  names: Map<string, string>;
  timeZone: string;
}) {
  const m = useMunicipality();
  const { locale, t } = usePreferences();
  const q = useMunicipalPages<Block>(path);
  return (
    <section className={styles.section}>
      <h2>{t("Bloqueos", "Bloqueos")}</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.pages[0]?.items.length && (
            <p>
              {t(
                "No hay bloqueos para este día y ámbito.",
                "Non hai bloqueos para este día e ámbito.",
              )}
            </p>
          )}
          {q.data.pages
            .flatMap((p) => p.items)
            .map((b) => (
              <article key={b.id} className={styles.section}>
                <h3>{names.get(b.unitId) ?? b.unitId}</h3>
                <p>
                  {dateTime(b.startsAt, timeZone, locale)} —{" "}
                  {dateTime(b.endsAt, timeZone, locale)}
                </p>
                <p>{b.reason}</p>
                {b.releasedAt ? (
                  <p>{t("Liberado", "Liberado")}</p>
                ) : (
                  <AdministrativeAction
                    path={`${endpoint(m.id)}/blocks/${b.id}/release`}
                    label={t("Liberar bloqueo", "Liberar bloqueo")}
                    body={(d) => ({ reason: textField(d, "reason") })}
                  >
                    <Reason />
                    <Checkbox
                      required
                      label={t(
                        "Confirmo la liberación",
                        "Confirmo a liberación",
                      )}
                    />
                  </AdministrativeAction>
                )}
              </article>
            ))}
          <More query={q} />
        </>
      )}
    </section>
  );
}
function LocalInstant({
  label,
  timeZone,
  onValue,
}: {
  label: string;
  timeZone: string;
  onValue: (v: string) => void;
}) {
  const { t } = usePreferences();
  const [local, setLocal] = useState("");
  const [selected, setSelected] = useState("");
  const choices = localInstants(local, timeZone);
  return (
    <>
      <Input
        type="datetime-local"
        required
        label={label}
        value={local}
        onChange={(e) => {
          const value = e.target.value;
          setLocal(value);
          const options = localInstants(value, timeZone);
          const next = options.length === 1 ? (options[0]?.utc ?? "") : "";
          setSelected(next);
          onValue(next);
        }}
      />
      {choices.length > 1 && (
        <Select
          placeholder={t("Selecciona una opción", "Selecciona unha opción")}
          required
          label={`${label}: ${t("desfase UTC", "desfase UTC")}`}
          value={selected}
          options={choices.map((c) => ({
            value: c.utc,
            label: `UTC${c.offset}`,
          }))}
          onValueChange={(v) => {
            setSelected(v);
            onValue(v);
          }}
        />
      )}
      {local && !choices.length && (
        <p role="alert">
          {t(
            "Esta hora no existe en la zona municipal. Elige otra hora.",
            "Esta hora non existe na zona municipal. Escolle outra hora.",
          )}
        </p>
      )}
    </>
  );
}
function CreateBlock({
  timeZone,
  units,
}: {
  timeZone: string;
  units: PlanningUnit[];
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [unit, setUnit] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  return (
    <AdministrativeAction
      path={`${endpoint(m.id)}/blocks`}
      label={t("Crear bloqueo", "Crear bloqueo")}
      body={(d) => ({
        unitId: unit,
        startsAt: start,
        endsAt: end,
        reason: textField(d, "reason"),
      })}
      disabled={!unit || !start || !end || Date.parse(start) >= Date.parse(end)}
    >
      <Select
        placeholder={t("Selecciona una opción", "Selecciona unha opción")}
        required
        label={t("Unidad a bloquear", "Unidade que se vai bloquear")}
        value={unit}
        options={units.map((u) => ({ value: u.id, label: u.name }))}
        onValueChange={setUnit}
      />
      <LocalInstant
        label={t("Inicio del bloqueo", "Inicio do bloqueo")}
        timeZone={timeZone}
        onValue={setStart}
      />
      <LocalInstant
        label={t("Fin del bloqueo", "Fin do bloqueo")}
        timeZone={timeZone}
        onValue={setEnd}
      />
      <p>
        {t(
          "El bloqueo no cancela reservas. Si existe una ocupación incompatible, se rechaza sin cambios.",
          "O bloqueo non cancela reservas. Se existe unha ocupación incompatible, rexéitase sen cambios.",
        )}
      </p>
      <Reason />
      <Checkbox
        required
        label={t("Confirmo el bloqueo", "Confirmo o bloqueo")}
      />
    </AdministrativeAction>
  );
}
export function AdministrativeAction({
  path,
  body,
  label,
  children,
  disabled = false,
}: {
  path: string;
  body: (d: FormData) => unknown;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [uncertain, setUncertain] = useState(false);
  if (uncertain || (account && readCommand(account.accountId)))
    return <PendingLink />;
  return (
    <ActionForm
      disabled={disabled}
      label={label}
      submit={async (d) => {
        if (!account || disabled) return;
        const policy = await api<CommandPolicy>(
          "/api/public/reservation-command-policy",
          {},
          locale,
        );
        const command = {
          owner: account.accountId,
          path,
          key: crypto.randomUUID(),
          body: JSON.stringify(body(d)),
          createdAt: Date.parse(policy.serverTime),
          retentionSeconds: policy.retentionSeconds,
        };
        try {
          const result = await sendCommand<{ tenantId: string; id: string }>(
            command,
            locale,
          );
          await client.invalidateQueries({
            queryKey: ["private", account.accountId, "municipal"],
          });
          await client.invalidateQueries({ queryKey: ["public"] });
          navigate(commandResultPath(command, result), { replace: true });
        } catch (error) {
          if (readCommand(account.accountId)) {
            setUncertain(true);
            return;
          }
          throw error;
        }
      }}
    >
      {children}
      {disabled && (
        <p role="status">
          {t(
            "Completa una unidad y un intervalo válido antes de confirmar.",
            "Completa unha unidade e un intervalo válido antes de confirmar.",
          )}
        </p>
      )}
    </ActionForm>
  );
}
export function AdministrativeReservation() {
  const m = useMunicipality();
  const { reservationId = "" } = useParams();
  const q = useMunicipalQuery<Reservation>(
    `${endpoint(m.id)}/reservations/${reservationId}`,
  );
  const { t } = usePreferences();
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <Failure error={q.error} retry={() => void q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  if (
    !permitted(m, "RESERVATION_READ", r.unitId) &&
    !permitted(m, "RESERVATION_MANAGE", r.unitId)
  )
    return <Denied />;
  return (
    <>
      <Link to={`${municipalPath(m.id)}/agenda`}>
        {t("Agenda diaria", "Axenda diaria")}
      </Link>
      <h1>{t("Reserva", "Reserva")}</h1>
      <ReservationSummary reservation={r} />
      <p>{r.status}</p>
      <p>
        {t("Unidad:", "Unidade:")} {r.unitId}
      </p>
      {r.usageRulesUnitId && r.usageRulesVersion !== null ? (
        <Disclosure
          title={
            <>
              {t("Normas aceptadas", "Normas aceptadas")} ·{" "}
              {t("versión", "versión")} {r.usageRulesVersion}
            </>
          }
        >
          <p>
            {t("Unidad:", "Unidade:")} {r.usageRulesUnitId}
          </p>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {r.usageRulesText}
          </p>
        </Disclosure>
      ) : (
        <p>{t("Sin aceptación registrada.", "Sen aceptación rexistrada.")}</p>
      )}
      {r.pendingUsageRulesVersion !== null && (
        <Disclosure
          title={
            <>
              {t(
                "Normas pendientes de aceptación",
                "Normas pendentes de aceptación",
              )}{" "}
              · {t("versión", "versión")} {r.pendingUsageRulesVersion}
            </>
          }
        >
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {r.pendingUsageRulesText}
          </p>
        </Disclosure>
      )}

      <p>
        {t("Titular:", "Titular:")} {r.accountId}
      </p>
      {r.pendingUsageRulesVersion !== null && (
        <p className={styles.notice}>
          {t(
            "El titular tiene normas pendientes de aceptar. No se cancelará ni revertirá la reserva automáticamente.",
            "O titular ten normas pendentes de aceptar. Non se cancelará nin reverterá a reserva automaticamente.",
          )}
        </p>
      )}
      <p>
        {t(
          "Plazo de cancelación aceptado (minutos):",
          "Prazo de cancelación aceptado (minutos):",
        )}{" "}
        {r.cancellationMinutes}
      </p>
      {permitted(m, "RESERVATION_MANAGE", r.unitId) &&
        r.status === "CONFIRMADA" &&
        Date.parse(r.startsAt) > Date.now() && (
          <ReservationOperations
            key={`${r.id}:${r.revision}`}
            reservation={r}
          />
        )}
    </>
  );
}
function ReservationOperations({
  reservation: r,
}: {
  reservation: Reservation;
}) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const units = useMunicipalPages<PlanningUnit>(
    `${endpoint(m.id)}/agenda/units`,
  );
  const [target, setTarget] = useState(r.unitId);
  return (
    <>
      <section className={styles.section}>
        <h2>{t("Reubicar reserva", "Reubicar reserva")}</h2>
        <p>
          {t(
            "El cambio es inmediato. Conserva las condiciones de cancelación aceptadas y comunica la reubicación al titular. Si cambian las normas, solo él puede aceptarlas.",
            "O cambio é inmediato. Conserva as condicións de cancelación aceptadas e comunica a reubicación ao titular. Se cambian as normas, só el pode aceptalas.",
          )}
        </p>
        {units.isPending ? (
          <Loading />
        ) : units.isError ? (
          <Failure error={units.error} />
        ) : (
          <>
            <Select
              placeholder={t("Selecciona una opción", "Selecciona unha opción")}
              label={t("Unidad de destino", "Unidade de destino")}
              value={target}
              onValueChange={setTarget}
              options={units.data.pages
                .flatMap((p) => p.items)
                .filter((u) => permitted(m, "RESERVATION_MANAGE", u.id))
                .map((u) => ({ value: u.id, label: u.name }))}
            />
            <More query={units} />
            <Relocation key={target} reservation={r} target={target} />
          </>
        )}
      </section>
      <section className={styles.section}>
        <h2>{t("Cancelación administrativa", "Cancelación administrativa")}</h2>
        <AdministrativeAction
          path={`${endpoint(m.id)}/reservations/${r.id}/cancel`}
          label={t(
            "Cancelar administrativamente",
            "Cancelar administrativamente",
          )}
          body={(d) => ({
            expectedRevision: r.revision,
            administrative: true,
            reason: textField(d, "reason"),
          })}
        >
          <p>
            {t(
              "Libera la ocupación y la cuota. No exige aceptar normas ni aplica el plazo ciudadano.",
              "Libera a ocupación e a cota. Non esixe aceptar normas nin aplica o prazo cidadán.",
            )}
          </p>
          <Reason />
          <Checkbox
            required
            label={t("Confirmo la cancelación", "Confirmo a cancelación")}
          />
        </AdministrativeAction>
      </section>
    </>
  );
}
function Relocation({
  reservation,
  target,
}: {
  reservation: Reservation;
  target: string;
}) {
  const m = useMunicipality();
  const q = useMunicipalQuery<Unit>(
    `/api/public/municipalities/${m.id}/units/${target}`,
  );
  if (q.isPending) return <Loading />;
  if (q.isError) return <Failure error={q.error} />;
  return q.data ? (
    <RelocationSlots key={target} reservation={reservation} unit={q.data} />
  ) : null;
}
function RelocationSlots({
  reservation: r,
  unit,
}: {
  reservation: Reservation;
  unit: Unit;
}) {
  const m = useMunicipality();
  const { locale, t } = usePreferences();
  const [date, setDate] = useState(() => municipalToday(unit.timeZone));
  const [duration, setDuration] = useState(unit.calendar.minimumMinutes);
  const [slot, setSlot] = useState("");
  const q = useMunicipalQuery<Availability>(
    `${endpoint(m.id)}/reservations/${r.id}/availability?administrative=true&unitId=${unit.id}&date=${date}&durationMinutes=${duration}`,
  );
  const selected = q.data?.slots.find((s) => s.start.utc === slot);
  return (
    <>
      <div className={styles.row}>
        <Input
          type="date"
          required
          label={t("Nueva fecha", "Nova data")}
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setSlot("");
          }}
        />
        <Input
          type="number"
          required
          label={t("Duración (minutos)", "Duración (minutos)")}
          value={duration}
          min={unit.calendar.minimumMinutes}
          max={unit.calendar.maximumMinutes}
          step={unit.calendar.stepMinutes}
          onChange={(e) => {
            setDuration(Number(e.target.value));
            setSlot("");
          }}
        />
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <Failure error={q.error} retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            <Select
              placeholder={t("Selecciona una opción", "Selecciona unha opción")}
              label={t("Franja disponible", "Franxa dispoñible")}
              value={slot}
              onValueChange={setSlot}
              options={q.data.slots.map((s) => ({
                value: s.start.utc,
                label: `${dateTime(s.start.utc, unit.timeZone, locale)} — ${dateTime(s.end.utc, unit.timeZone, locale)}`,
              }))}
            />
            {!q.data.slots.length && (
              <p>
                {t(
                  "No hay franjas disponibles.",
                  "Non hai franxas dispoñibles.",
                )}
              </p>
            )}
          </>
        )
      )}
      {selected && (
        <AdministrativeAction
          path={`${endpoint(m.id)}/reservations/${r.id}/modify`}
          label={t("Confirmar reubicación", "Confirmar reubicación")}
          body={(d) => ({
            expectedRevision: r.revision,
            unitId: unit.id,
            startsAt: selected.start.utc,
            endsAt: selected.end.utc,
            administrative: true,
            reason: textField(d, "reason"),
          })}
        >
          <p>
            {dateTime(selected.start.utc, unit.timeZone, locale)} —{" "}
            {dateTime(selected.end.utc, unit.timeZone, locale)}
          </p>
          <Reason />
          <Checkbox
            required
            label={t(
              "Confirmo el cambio sin aceptar normas en nombre del titular.",
              "Confirmo o cambio sen aceptar normas en nome do titular.",
            )}
          />
        </AdministrativeAction>
      )}
    </>
  );
}
