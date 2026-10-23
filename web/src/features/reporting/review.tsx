import { useState } from "react";
import { ActionForm, textField } from "../../app/action";
import { api } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import { CollaborationAction } from "../collaboration/action";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import type { CommandResult } from "../reservations/commands";
import { MonthlyFields, uuidPattern } from "./fields";
import type { ReviewContext } from "./model";
export function MonthlyReview() {
  const m = useMunicipality();
  return m.administrator ? <Review key={m.id} /> : <Denied />;
}
function Review() {
  const m = useMunicipality(),
    { t, locale } = usePreferences();
  const [context, setContext] = useState<ReviewContext>();
  const [saved, setSaved] = useState<CommandResult>();
  const [generation, setGeneration] = useState(0);
  const base = context
    ? `${endpoint(m.id)}/agreements/${context.agreementId}/reports/${context.month}`
    : "";
  return (
    <>
      <h1>
        {t("Revisión de informe conjunto", "Revisión de informe conxunto")}
      </h1>
      <p>
        {t(
          "Registra la evaluación de riesgo para una revisión y destinatario concretos. Las referencias documentan la revisión humana; no acreditan anonimato ni autorizan por sí solas la entrega. No introduzcas datos personales ni documentos completos.",
          "Rexistra a avaliación de risco para unha revisión e destinatario concretos. As referencias documentan a revisión humana; non acreditan anonimato nin autorizan por si soas a entrega. Non introduzas datos persoais nin documentos completos.",
        )}
      </p>
      {!context ? (
        <ActionForm
          key={generation}
          label={t(
            "Consultar contexto de revisión",
            "Consultar contexto de revisión",
          )}
          resetOnSuccess={false}
          submit={async (d) => {
            const agreement = textField(d, "agreementId").trim().toLowerCase(),
              month = textField(d, "month");
            const params = new URLSearchParams({
              revision: textField(d, "revision"),
              recipientTenantId: textField(d, "recipientTenantId")
                .trim()
                .toLowerCase(),
              recipientAccountId: textField(d, "recipientAccountId").trim(),
            });
            setSaved(undefined);
            setContext(
              await api<ReviewContext>(
                `${endpoint(m.id)}/agreements/${encodeURIComponent(agreement)}/reports/${encodeURIComponent(month)}/review-context?${params}`,
                {},
                locale,
              ),
            );
          }}
        >
          <MonthlyFields />
          <Input
            name="revision"
            label={t("Revisión preparada", "Revisión preparada")}
            required
            type="number"
            min={1}
            max={2147483647}
            step={1}
          />
          <Input
            name="recipientTenantId"
            label={t(
              "Municipio destinatario (identificador)",
              "Municipio destinatario (identificador)",
            )}
            required
            pattern={uuidPattern}
          />
          <Input
            name="recipientAccountId"
            label={t(
              "Cuenta destinataria (identificador)",
              "Conta destinataria (identificador)",
            )}
            required
            maxLength={200}
          />
        </ActionForm>
      ) : (
        <>
          <h2>{t("Contexto de evaluación", "Contexto de avaliación")}</h2>
          <p>
            {context.agreementId} · {context.month} ·{" "}
            {t("Revisión", "Revisión")} {context.revision}
          </p>
          <p>
            {t("Municipio destinatario", "Municipio destinatario")}:{" "}
            {context.recipientTenantId}
          </p>
          <p>
            {t("Cuenta destinataria", "Conta destinataria")}:{" "}
            {context.recipientAccountId}
          </p>
          {saved ? (
            <p role="status">
              {t("Revisión registrada", "Revisión rexistrada")}:{" "}
              {saved.reviewId} ·{" "}
              {saved.decision === "APPROVE"
                ? t("Favorable", "Favorable")
                : t("Desfavorable", "Desfavorable")}
            </p>
          ) : (
            <CollaborationAction
              key={generation}
              path={`${base}/reviews`}
              label={t("Registrar evaluación", "Rexistrar avaliación")}
              onResult={setSaved}
              body={(d) => ({
                revision: context.revision,
                recipientTenantId: context.recipientTenantId,
                recipientAccountId: context.recipientAccountId,
                expectedHistoryDigest: context.historyDigest,
                decision: textField(d, "decision"),
                auxiliaryReference: textField(d, "auxiliaryReference").trim(),
                ownDataReference: textField(d, "ownDataReference").trim(),
                priorReleasesReference: textField(
                  d,
                  "priorReleasesReference",
                ).trim(),
                correctionReference:
                  context.revision > 1
                    ? textField(d, "correctionReference").trim()
                    : null,
              })}
            >
              <Select
                name="decision"
                label={t("Decisión", "Decisión")}
                required
                options={[
                  { value: "APPROVE", label: t("Favorable", "Favorable") },
                  { value: "REJECT", label: t("Desfavorable", "Desfavorable") },
                ]}
              />
              <Input
                name="auxiliaryReference"
                label={t(
                  "Referencia de información auxiliar",
                  "Referencia de información auxiliar",
                )}
                required
                maxLength={500}
              />
              <Input
                name="ownDataReference"
                label={t(
                  "Referencia de datos propios del destinatario",
                  "Referencia de datos propios do destinatario",
                )}
                required
                maxLength={500}
              />
              <Input
                name="priorReleasesReference"
                label={t(
                  "Referencia de entregas anteriores",
                  "Referencia de entregas anteriores",
                )}
                required
                maxLength={500}
              />
              {context.revision > 1 && (
                <Input
                  name="correctionReference"
                  label={t(
                    "Referencia del riesgo entre correcciones",
                    "Referencia do risco entre correccións",
                  )}
                  required
                  maxLength={500}
                />
              )}
              <Checkbox
                required
                label={t(
                  "Confirmo la evaluación y el destinatario indicados",
                  "Confirmo a avaliación e o destinatario indicados",
                )}
              />
            </CollaborationAction>
          )}
          <p>
            {t(
              "Si cambia el historial de entregas, el servidor rechaza la huella anterior. Actualiza el contexto y revisa de nuevo antes de registrar otra evaluación.",
              "Se cambia o historial de entregas, o servidor rexeita a pegada anterior. Actualiza o contexto e revisa de novo antes de rexistrar outra avaliación.",
            )}
          </p>
          <Button
            variant="secondary"
            onClick={async () => {
              setSaved(undefined);
              setContext(undefined);
              setGeneration((g) => g + 1);
            }}
          >
            {t("Consultar otro contexto", "Consultar outro contexto")}
          </Button>
        </>
      )}
    </>
  );
}
