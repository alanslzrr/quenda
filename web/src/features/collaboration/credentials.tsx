import { useState } from "react";
import { useSearchParams } from "react-router";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { Disclosure } from "../../app/disclosure";
import { Failure, Loading } from "../../app/feedback";
import { ActionLink as Link } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { blocksEditor, EditorRecovery } from "../../app/read-recovery";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Select } from "../../ui/select/select";
import {
  type AccountLabelValue,
  accountText,
} from "../municipal/account-label";
import { AccountSelect } from "../municipal/account-select";
import {
  Denied,
  endpoint,
  More,
  Reason,
  useMunicipality,
  useMunicipalPages,
} from "../municipal/shared";
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
  if (blocksEditor(query) || !query.data)
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
    <EditorRecovery
      error={query.isError ? query.error : null}
      retry={() => void query.refetch()}
    >
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
          <AccountSelect
            label={t("Persona beneficiaria", "Persoa beneficiaria")}
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
    </EditorRecovery>
  );
}
export function Credentials() {
  return useMunicipality().administrator ? <Revoke /> : <Denied />;
}
function Revoke() {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const [search] = useSearchParams();
  const [id, setId] = useState(() => {
    const reference = search.get("referencia") ?? "";
    // Pending-command recovery only accepts lower-case ids, and a malformed link must not start blocked.
    return new RegExp(`^${uuidPattern}$`).test(reference)
      ? reference.toLowerCase()
      : "";
  });
  const [confirmed, setConfirmed] = useState(false);
  function changeId(value: string) {
    setId(value.trim().toLowerCase());
    setConfirmed(false);
  }
  const [receipt, setReceipt] = useState<string>();
  const query = useMunicipalPages<{
    id: string;
    agreementName: string;
    accountId: string;
    accountLabel: AccountLabelValue;
    startsAt: string;
    endsAt: string;
    revokedAt: string | null;
  }>(`${endpoint(m.id)}/credentials`);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h1>{t("Acreditaciones de uso", "Acreditacións de uso")}</h1>
      <p>
        {t(
          "Autorizan a una persona a usar los espacios de un convenio que exige acreditación. No son reservas ni garantizan disponibilidad.",
          "Autorizan unha persoa a usar os espazos dun convenio que esixe acreditación. Non son reservas nin garanten dispoñibilidade.",
        )}
      </p>
      <p>
        {t(
          "Para emitir una acreditación, abre la versión del convenio. Para revocar, selecciona una acreditación emitida por este municipio; no se consultan acreditaciones ajenas.",
          "Para emitir unha acreditación, abre a versión do convenio. Para revogar, selecciona unha acreditación emitida por este municipio; non se consultan acreditacións alleas.",
        )}
      </p>
      <Link to={agreementPath(m.id)}>
        {t("Emitir desde un convenio", "Emitir desde un convenio")}
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
          body={(d) => {
            if (!new RegExp(`^${uuidPattern}$`).test(id))
              throw new ApiError(
                400,
                "INVALID_INPUT",
                t(
                  "Selecciona una acreditación o indica su referencia.",
                  "Selecciona unha acreditación ou indica a súa referencia.",
                ),
              );
            return { reason: textField(d, "reason").trim() };
          }}
          onResult={(r) => setReceipt(r.id)}
        >
          <Select
            disabled={!rows.length}
            label={t("Acreditación emitida", "Acreditación emitida")}
            placeholder={t(
              "Selecciona una acreditación",
              "Selecciona unha acreditación",
            )}
            value={rows.some((row) => row.id === id) ? id : ""}
            onValueChange={(value) => {
              // A manual reference may not belong to the paginated options.
              // Ignore the native empty-select synchronization in that case.
              if (value) changeId(value);
            }}
            options={rows.map((row) => ({
              value: row.id,
              label: `${accountText(row.accountLabel, t("Cuenta no disponible", "Conta non dispoñible"))} · ${row.agreementName} · ${new Date(row.startsAt).toLocaleDateString(locale)} – ${new Date(row.endsAt).toLocaleDateString(locale)}${row.revokedAt ? t(" · Revocada", " · Revogada") : ""}`,
              disabled: !!row.revokedAt,
            }))}
          />
          {query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <Failure error={query.error} retry={() => void query.refetch()} />
          ) : (
            <>
              <More query={query} />
              {!rows.length && (
                <p>
                  {t(
                    "No hay acreditaciones emitidas por este municipio.",
                    "Non hai acreditacións emitidas por este municipio.",
                  )}
                </p>
              )}
            </>
          )}
          <Disclosure
            title={t(
              "Usar una referencia conocida",
              "Usar unha referencia coñecida",
            )}
          >
            <Input
              label={t(
                "Identificador de acreditación",
                "Identificador de acreditación",
              )}
              value={id}
              onChange={(e) => changeId(e.target.value)}
            />
          </Disclosure>
          <p>
            {t(
              "Puede revocarse aunque el convenio esté suspendido. Las reservas confirmadas se conservan.",
              "Pode revogarse aínda que o convenio estea suspendido. As reservas confirmadas consérvanse.",
            )}
          </p>
          <Reason />
          <Checkbox
            required
            checked={confirmed}
            onCheckedChange={(value) => setConfirmed(value === true)}
            label={t("Confirmo la revocación", "Confirmo a revogación")}
          />
        </CollaborationAction>
      )}
    </>
  );
}
