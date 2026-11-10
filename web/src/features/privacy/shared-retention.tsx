import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { uuidPattern } from "../collaboration/model";
import { usePrivacyScope } from "./context";
import { ActionFields, Authorization } from "./fields";
import { PrivacyForm } from "./form";
import { period } from "./model";

interface Context {
  ownerTenantId: string;
  category: "RESERVATIONS" | "ACCREDITATIONS";
  targetKey: string;
  action: "ERASE" | "BLOCK";
  blockDays: number | null;
  digest: string;
  controllers: Array<{ tenantId: string; name: string; approved: boolean }>;
}
export function SharedRetention() {
  const scope = usePrivacyScope();
  const { t, locale } = usePreferences();
  const [context, setContext] = useState<Context>();
  const [decision, setDecision] = useState("approve");
  const [done, setDone] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const descriptor = context && {
    ownerTenantId: context.ownerTenantId,
    category: context.category,
    targetKey: context.targetKey,
    action: context.action,
    ...(context.blockDays !== null ? { blockDays: context.blockDays } : {}),
  };
  return (
    <>
      <h2>{t("Conservación compartida", "Conservación compartida")}</h2>
      <p>
        {t(
          "Cada municipio responsable debe revisar la misma actuación y registrar su propia autorización. Esta revisión no elimina datos. Las excepciones de conservación y las dependencias siguen vigentes.",
          "Cada municipio responsable debe revisar a mesma actuación e rexistrar a súa propia autorización. Esta revisión non elimina datos. As excepcións de conservación e as dependencias seguen vixentes.",
        )}
      </p>
      {!context ? (
        <ActionForm
          label={t("Consultar revisión", "Consultar revisión")}
          submit={async (data) => {
            setContext(
              await api<Context>(
                `${scope.base}/shared-retention/context`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    ownerTenantId: textField(data, "ownerTenantId").trim(),
                    category: textField(data, "category"),
                    targetKey: textField(data, "targetKey").trim(),
                    action: textField(data, "action"),
                    ...(textField(data, "action") === "BLOCK"
                      ? { blockDays: period(data.get("blockDays")) }
                      : {}),
                  }),
                },
                locale,
              ),
            );
            setDone(false);
            setConfirmed(false);
          }}
        >
          <Input
            required
            name="ownerTenantId"
            pattern={uuidPattern}
            label={t(
              "Referencia del municipio titular",
              "Referencia do municipio titular",
            )}
          />
          <Select
            name="category"
            required
            label={t("Categoría", "Categoría")}
            options={[
              {
                value: "RESERVATIONS",
                label: t(
                  "Reservas y consumos compartidos",
                  "Reservas e consumos compartidos",
                ),
              },
              {
                value: "ACCREDITATIONS",
                label: t(
                  "Acreditaciones compartidas",
                  "Acreditacións compartidas",
                ),
              },
            ]}
          />
          <Input
            required
            name="targetKey"
            pattern={uuidPattern}
            label={t("Referencia del registro", "Referencia do rexistro")}
          />
          <ActionFields />
        </ActionForm>
      ) : (
        <>
          <dl>
            <dt>{t("Municipio titular", "Municipio titular")}</dt>
            <dd>
              {
                context.controllers.find(
                  (c) => c.tenantId === context.ownerTenantId,
                )?.name
              }{" "}
              ({context.ownerTenantId})
            </dd>
            <dt>{t("Registro", "Rexistro")}</dt>
            <dd>{context.targetKey}</dd>
            <dt>{t("Actuación", "Actuación")}</dt>
            <dd>
              {context.action === "ERASE"
                ? t("Suprimir", "Suprimir")
                : t(
                    `Bloquear durante ${context.blockDays} días`,
                    `Bloquear durante ${context.blockDays} días`,
                  )}
            </dd>
          </dl>
          <ul>
            {context.controllers.map((c) => (
              <li key={c.tenantId}>
                {c.name} ({c.tenantId}):{" "}
                {c.approved
                  ? t("Aprobado", "Aprobado")
                  : t("Pendiente", "Pendente")}
              </li>
            ))}
          </ul>
          <p>
            {t(
              "Si cambia el registro, la política vigente o la actuación, todos los municipios deben revisar de nuevo.",
              "Se cambia o rexistro, a política vixente ou a actuación, todos os municipios deben revisar de novo.",
            )}
          </p>
          {done ? (
            <p role="status">
              {t(
                "Revisión registrada. Consulta de nuevo para ver el estado conjunto.",
                "Revisión rexistrada. Consulta de novo para ver o estado conxunto.",
              )}
            </p>
          ) : (
            scope.execute && (
              <PrivacyForm
                path={`${scope.base}/shared-retention/review`}
                label={t(
                  "Registrar revisión municipal",
                  "Rexistrar revisión municipal",
                )}
                body={(data) => ({
                  ...descriptor,
                  digest: context.digest,
                  approved: decision === "approve",
                  authorizationReference: textField(
                    data,
                    "authorizationReference",
                  ),
                  reason: textField(data, "reason"),
                })}
                onResult={() => setDone(true)}
              >
                <Select
                  label={t("Decisión del municipio", "Decisión do municipio")}
                  value={decision}
                  onValueChange={(v) => {
                    setDecision(v);
                    setConfirmed(false);
                  }}
                  options={[
                    {
                      value: "approve",
                      label: t(
                        "Aprobar esta actuación",
                        "Aprobar esta actuación",
                      ),
                    },
                    {
                      value: "withdraw",
                      label: t("Retirar la aprobación", "Retirar a aprobación"),
                    },
                  ]}
                />
                <Authorization />
                <Checkbox
                  required
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmed(v === true)}
                  label={t(
                    "He revisado el registro, la actuación y la autorización de este municipio.",
                    "Revisei o rexistro, a actuación e a autorización deste municipio.",
                  )}
                />
              </PrivacyForm>
            )
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setContext(undefined);
              setConfirmed(false);
            }}
          >
            {t("Consultar otra vez", "Consultar outra vez")}
          </Button>
        </>
      )}
    </>
  );
}
