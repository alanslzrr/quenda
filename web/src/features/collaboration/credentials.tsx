import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Denied, endpoint, Reason, useMunicipality } from "../municipal/shared";
import { CollaborationAction } from "./action";
import { useAgreement } from "./agreements";
import { InstantField } from "./instant-field";
import { agreementPath, uuidPattern } from "./model";

export function IssueCredential() {
  return useMunicipality().administrator ? <Issue /> : <Denied />;
}
function Issue() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const query = useAgreement();
  const [receipt, setReceipt] = useState<string>();
  if (query.isPending) return <Loading />;
  if (query.isError || !query.data)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const a = query.data;
  if (
    !a.participants.some((p) => p.tenantId === m.id && p.accreditationIssuer) ||
    a.eligibility !== "acreditacion_vigente" ||
    a.status !== "ACTIVADO"
  )
    return (
      <p>
        {t(
          "Esta versión no permite emitir acreditaciones desde este municipio.",
          "Esta versión non permite emitir acreditacións desde este municipio.",
        )}
      </p>
    );
  return (
    <>
      <Link to={agreementPath(m.id, a.agreementId, a.version)}>
        {a.name} · {a.version}
      </Link>
      <h1>{t("Emitir acreditación", "Emitir acreditación")}</h1>
      {receipt ? (
        <section role="status">
          <p>
            {t(
              "Acreditación emitida. Conserva su identificador para una posible revocación.",
              "Acreditación emitida. Conserva o seu identificador para unha posible revogación.",
            )}
          </p>
          <p>{receipt}</p>
          <Link
            to={`/administracion/${m.id}/acreditaciones?referencia=${encodeURIComponent(receipt)}`}
          >
            {t("Revocar acreditación", "Revogar acreditación")}
          </Link>
        </section>
      ) : (
        <CollaborationAction
          path={`${endpoint(m.id)}/credentials`}
          label={t("Emitir acreditación", "Emitir acreditación")}
          onResult={(r) => setReceipt(r.id)}
          body={(d) => {
            const startsAt = textField(d, "startsAt"),
              endsAt = textField(d, "endsAt");
            if (
              !startsAt ||
              !endsAt ||
              Date.parse(startsAt) >= Date.parse(endsAt)
            )
              throw new ApiError(
                400,
                "INVALID_INPUT",
                t(
                  "Revisa la vigencia de la acreditación.",
                  "Revisa a vixencia da acreditación.",
                ),
              );
            return {
              agreementId: a.agreementId,
              version: a.version,
              accountId: textField(d, "accountId").trim(),
              startsAt,
              endsAt,
              verificationReference: textField(
                d,
                "verificationReference",
              ).trim(),
            };
          }}
        >
          <p>
            {t(
              "La cuenta debe estar vinculada a este municipio. El sistema comprueba la versión efectiva y el permiso de emisión; la acreditación no garantiza por sí sola una reserva.",
              "A conta debe estar vinculada a este municipio. O sistema comproba a versión efectiva e o permiso de emisión; a acreditación non garante por si soa unha reserva.",
            )}
          </p>
          <Input
            required
            name="accountId"
            maxLength={200}
            label={t("Identificador de la cuenta", "Identificador da conta")}
          />
          <InstantField
            name="startsAt"
            label={t("Inicio de acreditación", "Inicio de acreditación")}
            zone={a.timeZone}
          />
          <InstantField
            name="endsAt"
            label={t("Fin de acreditación", "Fin de acreditación")}
            zone={a.timeZone}
          />
          <Input
            required
            name="verificationReference"
            maxLength={500}
            label={t(
              "Referencia de verificación",
              "Referencia de verificación",
            )}
          />
          <Checkbox
            required
            label={t(
              "Confirmo la verificación y la vigencia indicadas",
              "Confirmo a verificación e a vixencia indicadas",
            )}
          />
        </CollaborationAction>
      )}
    </>
  );
}
export function Credentials() {
  return useMunicipality().administrator ? <Revoke /> : <Denied />;
}
function Revoke() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const [search] = useSearchParams();
  const [id, setId] = useState(search.get("referencia") ?? "");
  const [receipt, setReceipt] = useState<string>();
  return (
    <>
      <h1>{t("Acreditaciones", "Acreditacións")}</h1>
      <p>
        {t(
          "Para emitir una acreditación, abre la versión del convenio. La revocación requiere el identificador de una acreditación emitida por este municipio; no se consultan acreditaciones ajenas.",
          "Para emitir unha acreditación, abre a versión do convenio. A revogación require o identificador dunha acreditación emitida por este municipio; non se consultan acreditacións alleas.",
        )}
      </p>
      <Link to={agreementPath(m.id)}>
        {t("Consultar convenios", "Consultar convenios")}
      </Link>
      <h2>{t("Revocar acreditación", "Revogar acreditación")}</h2>
      {receipt ? (
        <p role="status">
          {t("Revocación registrada", "Revogación rexistrada")}: {receipt}
        </p>
      ) : (
        <CollaborationAction
          path={`${endpoint(m.id)}/credentials/${id}/revoke`}
          danger
          label={t("Revocar acreditación", "Revogar acreditación")}
          body={(d) => ({ reason: textField(d, "reason").trim() })}
          onResult={(r) => setReceipt(r.id)}
        >
          <Input
            required
            pattern={uuidPattern}
            label={t(
              "Identificador de acreditación",
              "Identificador de acreditación",
            )}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
          <p>
            {t(
              "Puede revocarse aunque el convenio esté suspendido. Las reservas confirmadas se conservan.",
              "Pode revogarse aínda que o convenio estea suspendido. As reservas confirmadas consérvanse.",
            )}
          </p>
          <Reason />
          <Checkbox
            required
            label={t("Confirmo la revocación", "Confirmo a revogación")}
          />
        </CollaborationAction>
      )}
    </>
  );
}
