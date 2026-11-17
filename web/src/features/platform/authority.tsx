import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { textField } from "../../app/action";
import { ApiError } from "../../app/api";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { Reason } from "../municipal/shared";
import staff from "../municipal/staff.module.css";
import { PlatformAccount } from "./account";
import { AccountField, InvitationDeadline, Receipt } from "./fields";
import { invitationDates } from "./model";
import { PlatformForm, platformApi } from "./shared";
export function Invite({ privacy = false }: { privacy?: boolean }) {
  const { t, locale } = usePreferences();
  const [result, setResult] = useState<{ invitationId: string }>();
  if (result)
    return (
      <Receipt
        result={result}
        message={t(
          "Invitación registrada. No concede permisos hasta su aceptación.",
          "Invitación rexistrada. Non concede permisos ata a súa aceptación.",
        )}
      />
    );
  return (
    <>
      <p>
        {privacy
          ? t(
              "Consulta y ejecución son permisos independientes sobre identidad y seguridad globales. No incluyen actividad municipal. El permiso sin fecha no caduca automáticamente y puede revocarse.",
              "Consulta e execución son permisos independentes sobre identidade e seguridade globais. Non inclúen actividade municipal. O permiso sen data non caduca automaticamente e pode revogarse.",
            )
          : t(
              "El operador habilitado puede incorporar municipios, gestionar operadores y suspender identidades comprometidas. Su permiso no caduca automáticamente y no incluye privacidad ni administración municipal.",
              "O operador habilitado pode incorporar municipios, xestionar operadores e suspender identidades comprometidas. O seu permiso non caduca automaticamente e non inclúe privacidade nin administración municipal.",
            )}
      </p>
      <PlatformForm<{ invitationId: string }>
        path={`${platformApi}/${privacy ? "privacy" : "operator"}-invitations`}
        label={t("Enviar invitación", "Enviar invitación")}
        body={(d) => {
          const permissions = ["PRIVACY_READ", "PRIVACY_EXECUTE"].filter((p) =>
            d.has(p),
          );
          if (privacy && !permissions.length)
            throw new ApiError(
              400,
              "INVALID_INPUT",
              t(
                "Selecciona al menos un permiso.",
                "Selecciona polo menos un permiso.",
              ),
            );
          return {
            accountId: textField(d, "accountId").trim(),
            ...invitationDates(d, locale, privacy),
            ...(privacy
              ? { permissions, reason: textField(d, "reason").trim() }
              : {}),
          };
        }}
        onResult={setResult}
      >
        <AccountField />
        <InvitationDeadline role={privacy} />
        {privacy && (
          <>
            <fieldset className={staff.permissions}>
              <legend>{t("Permisos", "Permisos")}</legend>
              <Checkbox
                name="PRIVACY_READ"
                label={t(
                  "Consultar datos de privacidad",
                  "Consultar datos de privacidade",
                )}
              />
              <Checkbox
                name="PRIVACY_EXECUTE"
                label={t(
                  "Ejecutar actuaciones de privacidad",
                  "Executar actuacións de privacidade",
                )}
              />
            </fieldset>
            <Reason />
          </>
        )}
        <Checkbox
          required
          label={t(
            "Confirmo la cuenta, el alcance y la vigencia",
            "Confirmo a conta, o alcance e a vixencia",
          )}
        />
      </PlatformForm>
    </>
  );
}
export function Revoke({
  kind,
}: {
  kind: "operator" | "invitation" | "privacy";
}) {
  const { t } = usePreferences();
  const { account } = useSession();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const id = search.get("id") ?? "";
  // The list passes the name in navigation state, never in the address.
  const state: unknown = useLocation().state;
  const name =
    state && typeof state === "object" && "name" in state
      ? typeof state.name === "string"
        ? state.name
        : null
      : null;
  const [result, setResult] = useState<{
    accountId?: string;
    invitationId?: string;
  }>();
  if (!id)
    return (
      <p role="alert">
        {t(
          "Selecciona la concesión o invitación desde su listado.",
          "Selecciona a concesión ou invitación desde a súa listaxe.",
        )}
      </p>
    );
  if (result)
    return (
      <Receipt
        result={result}
        message={t("Revocación registrada.", "Revogación rexistrada.")}
      />
    );
  return (
    <>
      {kind === "operator" ? (
        <p>
          <PlatformAccount id={id} name={name} />
        </p>
      ) : (
        <>
          {name && (
            <p>
              {t("Cuenta", "Conta")}: {name}
            </p>
          )}
          <p>
            {t("Invitación", "Invitación")}: {id}
          </p>
        </>
      )}
      <p>
        {kind === "operator"
          ? t(
              "Retira el permiso de operador e invalida sus invitaciones pendientes. Debe permanecer otro operador habilitado; no se cancela ninguna reserva.",
              "Retira o permiso de operador e invalida as súas invitacións pendentes. Debe permanecer outro operador habilitado; non se cancela ningunha reserva.",
            )
          : kind === "privacy"
            ? t(
                "Revoca esta invitación o sus permisos de privacidad ya aceptados. No modifica otras concesiones ni permisos municipales.",
                "Revoga esta invitación ou os seus permisos de privacidade xa aceptados. Non modifica outras concesións nin permisos municipais.",
              )
            : t(
                "Revoca solo una invitación no aceptada. No retira el permiso de un operador que ya la aceptó.",
                "Revoga só unha invitación non aceptada. Non retira o permiso dun operador que xa a aceptou.",
              )}
      </p>
      {kind === "operator" && id === account?.accountId && (
        <p>
          {t(
            "Estás retirando tu propio permiso. Conservarás tu cuenta personal.",
            "Estás retirando o teu propio permiso. Conservarás a túa conta persoal.",
          )}
        </p>
      )}
      <PlatformForm<{ accountId?: string; invitationId?: string }>
        path={`${platformApi}/${kind === "operator" ? "operators" : kind === "privacy" ? "privacy-invitations" : "operator-invitations"}/${encodeURIComponent(id)}/revoke`}
        label={t("Revocar", "Revogar")}
        danger
        body={(d) => ({ reason: textField(d, "reason").trim() })}
        onResult={(r) => {
          setResult(r);
          if (kind === "operator" && id === account?.accountId)
            navigate("/administracion", { replace: true });
        }}
      >
        <Reason />
        <Checkbox
          required
          label={t(
            "Confirmo la revocación indicada",
            "Confirmo a revogación indicada",
          )}
        />
      </PlatformForm>
    </>
  );
}
export function SuspendAccount() {
  const { t } = usePreferences();
  const { account } = useSession();
  const client = useQueryClient();
  const [id, setId] = useState("");
  const [result, setResult] = useState<{
    accountId: string;
    suspendedAt: string;
  }>();
  if (result)
    return (
      <Receipt
        result={result}
        message={t(
          "Cuenta suspendida. Las reservas se conservan.",
          "Conta suspendida. As reservas consérvanse.",
        )}
      />
    );
  return (
    <>
      <p>
        {t(
          "Revoca todas las sesiones y la autoridad administrativa de la cuenta en la instancia, aunque sea el último responsable. Conserva reservas e historial. La recuperación exige verificación operativa y sustitución de credenciales; no es una reactivación de autoservicio.",
          "Revoga todas as sesións e a autoridade administrativa da conta na instancia, aínda que sexa o último responsable. Conserva reservas e historial. A recuperación esixe verificación operativa e substitución de credenciais; non é unha reactivación de autoservizo.",
        )}
      </p>
      <PlatformForm<{ accountId: string; suspendedAt: string }>
        path={`${platformApi}/accounts/${encodeURIComponent(id.trim())}/suspend`}
        label={t("Suspender cuenta", "Suspender conta")}
        danger
        body={(d) => ({ reason: textField(d, "reason").trim() })}
        onResult={async (r) => {
          setResult(r);
          if (r.accountId === account?.accountId)
            await client.invalidateQueries({ queryKey: ["session"] });
        }}
      >
        <Input
          label={t("Identificador de cuenta", "Identificador de conta")}
          required
          maxLength={128}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <Reason />
        {id.trim() === account?.accountId && (
          <p role="alert">
            {t(
              "Vas a suspender tu propia cuenta y perderás esta sesión.",
              "Vas suspender a túa propia conta e perderás esta sesión.",
            )}
          </p>
        )}
        <Checkbox
          required
          label={t(
            "Confirmo la suspensión global por seguridad",
            "Confirmo a suspensión global por seguridade",
          )}
        />
      </PlatformForm>
    </>
  );
}
