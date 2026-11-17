import { useState } from "react";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { BackLink } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { Textarea } from "../../ui/textarea/textarea";
import styles from "../municipal/municipal.module.css";
import { MunicipalityName, UnitName } from "../municipal/names";
import { ManagementPage } from "../municipal/page";
import {
  endpoint,
  More,
  useMunicipality,
  useMunicipalPages,
} from "../municipal/shared";
import { CollaborationAction } from "./action";
import ui from "./collaboration.module.css";
import { InstantField } from "./instant-field";
import {
  type Agreement,
  agreementPath,
  type Participant,
  uuidPattern,
  validParticipants,
  validZone,
} from "./model";

type Row = Participant & { key: number; locked: boolean; unitsText: string };
export function AgreementEditor({ original }: { original?: Agreement }) {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [zone, setZone] = useState(
    original?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [eligibility, setEligibility] = useState(
    original?.eligibility ?? "acceso_abierto",
  );
  const [reports, setReports] = useState(original?.aggregateReports ?? false);
  const [rows, setRows] = useState<Row[]>(() =>
    (
      original?.participants ?? [
        { tenantId: m.id, accreditationIssuer: false, unitIds: [] },
      ]
    ).map((p, key) => ({
      ...p,
      key,
      locked: p.tenantId === m.id,
      unitsText: p.unitIds.join("\n"),
    })),
  );
  const [next, setNext] = useState(rows.length);
  const units = useMunicipalPages<{ id: string; name: string }>(
    `${endpoint(m.id)}/agenda/units`,
  );
  const [unit, setUnit] = useState("");
  const patch = (key: number, data: Partial<Row>) =>
    setRows((old) => old.map((p) => (p.key === key ? { ...p, ...data } : p)));
  const error = (es: string, gl: string) =>
    new ApiError(400, "INVALID_INPUT", t(es, gl));
  return (
    <ManagementPage
      title={
        original
          ? t("Nueva versión del convenio", "Nova versión do convenio")
          : t("Nuevo convenio", "Novo convenio")
      }
      breadcrumb={
        <BackLink to={agreementPath(m.id)}>
          {t("Consultar versiones", "Consultar versións")}
        </BackLink>
      }
    >
      {original && (
        <p className={styles.notice}>
          {original.name} · {t("Versión de partida", "Versión de partida")}:{" "}
          {original.version}.{" "}
          {t(
            "El nombre y la zona no cambian. La nueva versión no hereda aprobaciones ni activa capacidades.",
            "O nome e a zona non cambian. A nova versión non herda aprobacións nin activa capacidades.",
          )}
        </p>
      )}
      <CollaborationAction
        path={`${endpoint(m.id)}/agreements${original ? `/${original.agreementId}/versions` : ""}`}
        label={
          original
            ? t("Crear versión", "Crear versión")
            : t("Crear borrador", "Crear borrador")
        }
        body={(data) => {
          const participants = rows.map((p) => ({
            tenantId: p.tenantId.trim().toLowerCase(),
            accreditationIssuer: p.accreditationIssuer,
            unitIds: p.unitsText
              .split(/\s+/)
              .filter(Boolean)
              .map((u) => u.toLowerCase()),
          }));
          const startsAt = textField(data, "startsAt"),
            endsAt = textField(data, "endsAt");
          if (
            !validZone(zone) ||
            !startsAt ||
            !endsAt ||
            Date.parse(startsAt) >= Date.parse(endsAt)
          )
            throw error(
              "Revisa la zona y la vigencia; el fin debe ser posterior al inicio. Si una hora se repite, selecciona su desfase.",
              "Revisa a zona e a vixencia; o fin debe ser posterior ao inicio. Se unha hora se repite, selecciona o seu desfase.",
            );
          if (!validParticipants(participants, m.id))
            throw error(
              "Revisa los identificadores de municipios y unidades. No pueden repetirse ni excluir a este municipio.",
              "Revisa os identificadores de municipios e unidades. Non poden repetirse nin excluír este municipio.",
            );
          const quota = textField(data, "weeklyLimit").trim();
          const weeklyLimit = quota ? Number(quota) : null;
          if (
            weeklyLimit !== null &&
            (!Number.isSafeInteger(weeklyLimit) ||
              weeklyLimit < 1 ||
              weeklyLimit > 2147483647)
          )
            throw error(
              "La cuota debe ser un entero positivo o quedar vacía.",
              "A cota debe ser un enteiro positivo ou quedar baleira.",
            );
          return {
            ...(original
              ? { expectedVersion: original.version }
              : { name: textField(data, "name").trim(), timeZone: zone }),
            startsAt,
            endsAt,
            purpose: textField(data, "purpose").trim(),
            legalBasis: textField(data, "legalBasis").trim(),
            responsibilities: textField(data, "responsibilities").trim(),
            retentionPolicy: textField(data, "retentionPolicy").trim(),
            eligibility,
            weeklyLimit,
            aggregateReports: reports,
            participants,
          };
        }}
      >
        {!original && (
          <Input
            required
            maxLength={200}
            name="name"
            label={t("Nombre del convenio", "Nome do convenio")}
          />
        )}
        <Input
          label={t("Zona horaria IANA", "Zona horaria IANA")}
          value={zone}
          readOnly={!!original}
          required
          maxLength={100}
          onChange={(e) => setZone(e.target.value)}
        />
        <div className={ui.dates}>
          <InstantField
            name="startsAt"
            label={t("Inicio de vigencia", "Inicio de vixencia")}
            zone={zone}
            initial={original?.startsAt}
          />
          <InstantField
            name="endsAt"
            label={t("Fin de vigencia", "Fin de vixencia")}
            zone={zone}
            initial={original?.endsAt}
          />
        </div>
        <Textarea
          required
          name="purpose"
          maxLength={2000}
          label={t("Finalidad", "Finalidade")}
          defaultValue={original?.purpose}
        />
        <Textarea
          required
          name="legalBasis"
          maxLength={2000}
          label={t("Base jurídica", "Base xurídica")}
          defaultValue={original?.legalBasis}
        />
        <Textarea
          required
          name="responsibilities"
          maxLength={2000}
          label={t("Responsabilidades", "Responsabilidades")}
          defaultValue={original?.responsibilities}
        />
        <Textarea
          required
          name="retentionPolicy"
          maxLength={2000}
          label={t("Conservación acordada", "Conservación acordada")}
          defaultValue={original?.retentionPolicy}
        />
        <Select
          label={t("Acceso del convenio", "Acceso do convenio")}
          value={eligibility}
          onValueChange={(v) => setEligibility(v as typeof eligibility)}
          options={[
            {
              value: "acceso_abierto",
              label: t("Acceso abierto", "Acceso aberto"),
            },
            {
              value: "acreditacion_vigente",
              label: t("Acreditación vigente", "Acreditación vixente"),
            },
          ]}
        />
        <Input
          name="weeklyLimit"
          type="number"
          min={1}
          max={2147483647}
          step={1}
          label={t(
            "Máximo de reservas por cuenta y semana (opcional)",
            "Máximo de reservas por conta e semana (opcional)",
          )}
          defaultValue={original?.weeklyLimit ?? ""}
        />
        <p>
          {t(
            "Vacío: sin cuota conjunta. La semana empieza el lunes en la zona del convenio; cambiar de versión no reinicia consumos.",
            "Baleiro: sen cota conxunta. A semana comeza o luns na zona do convenio; cambiar de versión non reinicia consumos.",
          )}
        </p>
        <Checkbox
          checked={reports}
          onCheckedChange={(v) => setReports(v === true)}
          label={t(
            "Habilitar informes agregados",
            "Habilitar informes agregados",
          )}
          description={t(
            "Exige revisión de riesgo para activar la capacidad; no publica informes automáticamente.",
            "Esixe revisión de risco para activar a capacidade; non publica informes automaticamente.",
          )}
        />
        <h2>{t("Participantes y unidades", "Participantes e unidades")}</h2>
        <p>
          {t(
            "Cada municipio aprueba sus propias unidades. Utiliza los identificadores acordados; no se consultan datos privados de otros municipios.",
            "Cada municipio aproba as súas propias unidades. Utiliza os identificadores acordados; non se consultan datos privados doutros municipios.",
          )}
        </p>
        {rows.map((p, i) => (
          <fieldset className={ui.participant} key={p.key}>
            <legend>
              {t("Participante", "Participante")} {i + 1}
              {new RegExp(`^${uuidPattern}$`).test(p.tenantId) && (
                <>
                  {" · "}
                  <MunicipalityName id={p.tenantId} />
                </>
              )}
            </legend>
            <Input
              label={`${t("Municipio", "Municipio")} ${i + 1}`}
              required
              pattern={uuidPattern}
              value={p.tenantId}
              readOnly={p.locked}
              onChange={(e) => patch(p.key, { tenantId: e.target.value })}
            />
            <Checkbox
              label={`${t("Emisor de acreditaciones", "Emisor de acreditacións")} ${i + 1}`}
              checked={p.accreditationIssuer}
              onCheckedChange={(v) =>
                patch(p.key, { accreditationIssuer: v === true })
              }
            />
            <Textarea
              label={`${t("Unidades: un identificador por línea", "Unidades: un identificador por liña")} · ${i + 1}`}
              value={p.unitsText}
              onChange={(e) => patch(p.key, { unitsText: e.target.value })}
            />
            {/* The identifiers stay editable; their names confirm the choice. */}
            {(() => {
              const valid = new RegExp(`^${uuidPattern}$`);
              const ids = p.unitsText
                .split(/\s+/)
                .filter((id) => valid.test(id));
              return (
                valid.test(p.tenantId) &&
                ids.length > 0 && (
                  <ul className={ui.unitNames}>
                    {ids.map((id) => (
                      <li key={id}>
                        <UnitName tenantId={p.tenantId} id={id} />
                      </li>
                    ))}
                  </ul>
                )
              );
            })()}
            {p.locked ? (
              <>
                <Select
                  label={t(
                    "Añadir unidad municipal",
                    "Engadir unidade municipal",
                  )}
                  value={unit}
                  onValueChange={setUnit}
                  placeholder={t(
                    "Selecciona una unidad",
                    "Selecciona unha unidade",
                  )}
                  options={(
                    units.data?.pages.flatMap((x) => x.items) ?? []
                  ).map((u) => ({ value: u.id, label: u.name }))}
                />
                {units.isPending ? (
                  <Loading />
                ) : units.isError ? (
                  <Failure
                    error={units.error}
                    retry={() => void units.refetch()}
                  />
                ) : (
                  <More query={units} />
                )}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!unit || p.unitsText.split(/\s+/).includes(unit)}
                  onClick={() =>
                    patch(p.key, {
                      unitsText: [p.unitsText.trim(), unit]
                        .filter(Boolean)
                        .join("\n"),
                    })
                  }
                >
                  {t("Añadir unidad", "Engadir unidade")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="danger-ghost"
                onClick={() =>
                  setRows((old) => old.filter((x) => x.key !== p.key))
                }
              >
                {t("Quitar participante", "Quitar participante")} {i + 1}
              </Button>
            )}
          </fieldset>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setRows((old) => [
              ...old,
              {
                key: next,
                locked: false,
                tenantId: "",
                accreditationIssuer: false,
                unitIds: [],
                unitsText: "",
              },
            ]);
            setNext(next + 1);
          }}
        >
          {t("Añadir participante", "Engadir participante")}
        </Button>
        <Checkbox
          required
          label={t(
            "Confirmo la configuración del borrador",
            "Confirmo a configuración do borrador",
          )}
        />
      </CollaborationAction>
    </ManagementPage>
  );
}
