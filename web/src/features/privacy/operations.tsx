import { useState } from "react";
import { useSearchParams } from "react-router";
import { textField } from "../../app/action";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { uuidPattern } from "../collaboration/model";
import { Reason } from "../municipal/shared";
import { usePrivacyScope } from "./context";
import {
  ActionFields,
  Authorization,
  CategoryField,
  SubjectField,
  TargetField,
} from "./fields";
import { PrivacyForm } from "./form";
import { type ActionResult, conflictReason, period } from "./model";

const value = (d: FormData, k: string) => textField(d, k).trim();
const action = (d: FormData) => ({
  action: value(d, "action"),
  ...(value(d, "action") === "BLOCK"
    ? { blockDays: period(d.get("blockDays")) }
    : {}),
});
export function ApprovePolicy() {
  const s = usePrivacyScope();
  const { t } = usePreferences();
  const [id, setId] = useState<string>();
  return (
    <>
      <h2>{t("Registrar política aprobada", "Rexistrar política aprobada")}</h2>
      <p>
        {t(
          "Activa la ejecución automática para esta familia y sustituye su política anterior. Los plazos deben proceder de la aprobación del responsable, no de valores recomendados por Quenda.",
          "Activa a execución automática para esta familia e substitúe a súa política anterior. Os prazos deben proceder da aprobación do responsable, non de valores recomendados por Quenda.",
        )}
      </p>
      {id ? (
        <p role="status">
          {t("Política registrada", "Política rexistrada")}: {id}
        </p>
      ) : (
        <PrivacyForm<{ policyId: string }>
          path={`${s.base}/retention-policies`}
          label={t("Registrar política", "Rexistrar política")}
          onResult={(r) => setId(r.policyId)}
          body={(d) => ({
            category: value(d, "category"),
            retentionDays: period(d.get("retentionDays")),
            ...action(d),
            purpose: value(d, "purpose"),
            controllerReference: value(d, "controllerReference"),
            approvalReference: value(d, "approvalReference"),
            reason: value(d, "reason"),
          })}
        >
          <CategoryField />
          <Input
            required
            name="retentionDays"
            type="number"
            min={1}
            max={365000}
            step={1}
            label={t(
              "Plazo de conservación (días)",
              "Prazo de conservación (días)",
            )}
          />
          <p>
            {t(
              "Días completos de 24 horas desde el anclaje de la familia. No conviertas meses o años en días aproximados.",
              "Días completos de 24 horas desde a referencia temporal da familia. Non convertas meses ou anos en días aproximados.",
            )}
          </p>
          <ActionFields />
          <Input
            required
            name="purpose"
            maxLength={500}
            label={t("Finalidad", "Finalidade")}
          />
          <Input
            required
            name="controllerReference"
            maxLength={500}
            label={t("Referencia del responsable", "Referencia do responsable")}
          />
          <Input
            required
            name="approvalReference"
            maxLength={500}
            label={t("Referencia de aprobación", "Referencia de aprobación")}
          />
          <Reason />
          <Checkbox
            required
            label={t(
              "Confirmo la política aprobada y su ejecución automática en este ámbito",
              "Confirmo a política aprobada e a súa execución automática neste ámbito",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
export function RevokePolicy() {
  const s = usePrivacyScope();
  const { t } = usePreferences();
  const [search] = useSearchParams();
  const [id, setId] = useState(search.get("id") ?? "");
  const [done, setDone] = useState(false);
  return (
    <>
      <h2>{t("Retirar política", "Retirar política")}</h2>
      <p>
        {t(
          "Detiene nuevas actuaciones sobre registros ordinarios. No restaura datos ni amplía la conservación ya autorizada de archivos bloqueados.",
          "Detén novas actuacións sobre rexistros ordinarios. Non restaura datos nin amplía a conservación xa autorizada de arquivos bloqueados.",
        )}
      </p>
      {done ? (
        <p role="status">
          {t("Retirada registrada", "Retirada rexistrada")}: {id}
        </p>
      ) : (
        <PrivacyForm
          path={`${s.base}/retention-policies/${id}/revoke`}
          label={t("Retirar política", "Retirar política")}
          danger
          onResult={() => setDone(true)}
          body={(d) => ({ reason: value(d, "reason") })}
        >
          <Input
            required
            pattern={uuidPattern}
            value={id}
            onChange={(e) => setId(e.target.value)}
            label={t("Identificador de política", "Identificador de política")}
          />
          <Reason />
          <Checkbox
            required
            label={t(
              "Confirmo la retirada de esta política",
              "Confirmo a retirada desta política",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
export function CreateHold() {
  const s = usePrivacyScope();
  const { t } = usePreferences();
  const [kind, setKind] = useState("targetKey");
  const [category, setCategory] = useState("");
  const [id, setId] = useState<string>();
  return (
    <>
      <h2>{t("Registrar excepción", "Rexistrar excepción")}</h2>
      <p>
        {t(
          "Impide la destrucción de los datos afectados. No suspende el tratamiento ordinario ni equivale a bloquear datos o cuentas.",
          "Impide a destrución dos datos afectados. Non suspende o tratamento ordinario nin equivale a bloquear datos ou contas.",
        )}
      </p>
      {id ? (
        <p role="status">
          {t("Excepción registrada", "Excepción rexistrada")}: {id}
        </p>
      ) : (
        <PrivacyForm<{ holdId: string }>
          path={`${s.base}/retention-holds`}
          label={t("Registrar excepción", "Rexistrar excepción")}
          onResult={(r) => setId(r.holdId)}
          body={(d) => ({
            category: value(d, "category"),
            [kind]: value(d, kind),
            authorizationReference: value(d, "authorizationReference"),
            reason: value(d, "reason"),
          })}
        >
          <CategoryField value={category} onChange={setCategory} />
          <Select
            label={t("Alcance de la excepción", "Alcance da excepción")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "targetKey", label: t("Un registro", "Un rexistro") },
              {
                value: "subjectId",
                label: t("Un interesado", "Un interesado"),
              },
            ]}
          />
          {kind === "targetKey" ? (
            <TargetField category={category} />
          ) : (
            <SubjectField
              name="subjectId"
              label={t("Identificador de la cuenta", "Identificador da conta")}
            />
          )}
          <Authorization />
          <Checkbox
            required
            label={t(
              "Confirmo la excepción autorizada en este ámbito",
              "Confirmo a excepción autorizada neste ámbito",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
export function ReleaseHold() {
  const s = usePrivacyScope();
  const { t } = usePreferences();
  const [search] = useSearchParams();
  const [id, setId] = useState(search.get("id") ?? "");
  const [done, setDone] = useState(false);
  return (
    <>
      <h2>{t("Levantar excepción", "Levantar excepción")}</h2>
      <p>
        {t(
          "Permite que vuelvan a evaluarse las actuaciones autorizadas. No elimina los datos directamente.",
          "Permite que volvan avaliarse as actuacións autorizadas. Non elimina os datos directamente.",
        )}
      </p>
      {done ? (
        <p role="status">
          {t("Levantamiento registrado", "Levantamento rexistrado")}: {id}
        </p>
      ) : (
        <PrivacyForm
          path={`${s.base}/retention-holds/${id}/release`}
          label={t("Levantar excepción", "Levantar excepción")}
          onResult={() => setDone(true)}
          body={(d) => ({
            authorizationReference: value(d, "authorizationReference"),
            reason: value(d, "reason"),
          })}
        >
          <Input
            required
            pattern={uuidPattern}
            value={id}
            onChange={(e) => setId(e.target.value)}
            label={t(
              "Identificador de excepción",
              "Identificador de excepción",
            )}
          />
          <Authorization />
          <Checkbox
            required
            label={t(
              "Confirmo el levantamiento autorizado",
              "Confirmo o levantamento autorizado",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
export function IndividualAction() {
  const s = usePrivacyScope();
  const { t, locale } = usePreferences();
  const [category, setCategory] = useState("");
  const [result, setResult] = useState<ActionResult>();
  return (
    <>
      <h2>{t("Actuación individual", "Actuación individual")}</h2>
      <p>
        {t(
          "Requiere una autorización concreta. Se respetan reservas vigentes, excepciones y evidencias protegidas; no se eliminan unilateralmente referencias compartidas.",
          "Require unha autorización concreta. Respéctanse reservas vixentes, excepcións e evidencias protexidas; non se eliminan unilateralmente referencias compartidas.",
        )}
      </p>
      {result ? (
        <section role="status">
          <h3>
            {result.status === "APPLIED"
              ? t("Actuación aplicada", "Actuación aplicada")
              : result.status === "CONFLICT"
                ? t(
                    "Conflicto: actuación no aplicada",
                    "Conflito: actuación non aplicada",
                  )
                : t(
                    "Conjunto operativo ausente: no se ha aplicado la actuación",
                    "Conxunto operativo ausente: non se aplicou a actuación",
                  )}
          </h3>
          <p>
            {t("Evento de auditoría", "Evento de auditoría")}: {result.eventId}
          </p>
          {result.reason && (
            <p>
              {t("Motivo registrado", "Motivo rexistrado")}:{" "}
              {conflictReason(result.reason, locale)}
            </p>
          )}
        </section>
      ) : (
        <PrivacyForm<ActionResult>
          path={`${s.base}/privacy-actions`}
          label={t("Ejecutar actuación", "Executar actuación")}
          danger
          onResult={setResult}
          body={(d) => ({
            category: value(d, "category"),
            targetKey: value(d, "targetKey"),
            ...action(d),
            authorizationReference: value(d, "authorizationReference"),
            reason: value(d, "reason"),
          })}
        >
          <CategoryField value={category} onChange={setCategory} />
          <TargetField category={category} />
          <ActionFields />
          <Authorization />
          <Checkbox
            required
            label={t(
              "Confirmo la actuación autorizada sobre este registro y ámbito",
              "Confirmo a actuación autorizada sobre este rexistro e ámbito",
            )}
          />
        </PrivacyForm>
      )}
    </>
  );
}
