import { useState } from "react";
import { Link, NavLink, useParams } from "react-router";
import { textField } from "../../app/action";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { Input } from "../../ui/input/input";
import { SortableDataTable } from "../../ui/sortable-data-table/sortable-data-table";
import styles from "./municipal.module.css";
import {
  Denied,
  endpoint,
  More,
  MunicipalForm,
  municipalPath,
  Reason,
  useMunicipality,
  useMunicipalPages,
} from "./shared";
import { StaffInvite, useAuthoritySaved } from "./staff-forms";
import {
  type Administrator,
  canReplace,
  invitationEvent,
  type StaffInvitation,
  staffOperations,
} from "./staff-model";

export function MunicipalStaff() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const { section = "administradores" } = useParams();
  if (!m.administrator) return <Denied />;
  const base = `${municipalPath(m.id)}/personal`;
  return (
    <>
      <h1>{t("Personal y permisos", "Persoal e permisos")}</h1>
      <nav
        className={styles.row}
        aria-label={t("Personal municipal", "Persoal municipal")}
      >
        <NavLink end to={base}>
          {t("Administradores", "Administradores")}
        </NavLink>
        <NavLink to={`${base}/gestores`}>{t("Gestores", "Xestores")}</NavLink>
        <NavLink to={`${base}/invitar`}>{t("Invitar", "Invitar")}</NavLink>
        <NavLink to={`${base}/seguridad`}>
          {t("Retirada por seguridad", "Retirada por seguridade")}
        </NavLink>
      </nav>
      {section === "administradores" ? (
        <Administrators />
      ) : section === "gestores" ? (
        <InvitationHistory kind="manager" />
      ) : section === "invitar" ? (
        <section>
          <h2>{t("Nueva invitación", "Nova invitación")}</h2>
          <StaffInvite />
        </section>
      ) : section === "seguridad" ? (
        <SecurityWithdrawal />
      ) : (
        <Link to={base}>
          {t("Volver al personal municipal", "Volver ao persoal municipal")}
        </Link>
      )}
    </>
  );
}
function Administrators() {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const { account } = useSession();
  const saved = useAuthoritySaved();
  const query = useMunicipalPages<Administrator>(
    `${endpoint(m.id)}/administrators`,
  );
  const [selected, setSelected] = useState<string>();
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const item = rows.find((r) => r.accountId === selected);
  return (
    <>
      <h2>{t("Responsables municipales", "Responsables municipais")}</h2>
      <p>
        {t(
          "La retirada ordinaria exige otro administrador habilitado con permiso sin caducidad. Una invitación pendiente no completa el relevo.",
          "A retirada ordinaria esixe outro administrador habilitado con permiso sen caducidade. Unha invitación pendente non completa a substitución.",
        )}
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <SortableDataTable
            rows={rows}
            rowKey="accountId"
            caption={t("Administradores", "Administradores")}
            emptyMessage={t("No hay asignaciones.", "Non hai asignacións.")}
            columns={[
              {
                key: "accountId",
                label: t("Cuenta", "Conta"),
                sortable: false,
                render: (_, r) => (
                  <Button
                    variant="ghost"
                    onClick={() => setSelected(r.accountId)}
                  >
                    {r.accountId}
                    {r.accountId === account?.accountId
                      ? t(" (tu cuenta)", " (a túa conta)")
                      : ""}
                  </Button>
                ),
              },
              {
                key: "active",
                label: t("Estado actual", "Estado actual"),
                sortable: false,
                render: (_, r) =>
                  r.active
                    ? t("Habilitado", "Habilitado")
                    : t("No habilitado", "Non habilitado"),
              },
              {
                key: "expiresAt",
                label: t("Vigencia", "Vixencia"),
                sortable: false,
                render: (_, r) =>
                  r.expiresAt
                    ? new Date(r.expiresAt).toLocaleString(locale)
                    : t("Sin caducidad", "Sen caducidade"),
              },
            ]}
          />
          <More query={query} />
        </>
      )}
      {item && (
        <section
          className={styles.section}
          key={`${item.accountId}:${item.expiresAt}:${item.revokedAt}`}
        >
          <h3>
            {t("Administración de la cuenta", "Administración da conta")}:{" "}
            {item.accountId}
          </h3>
          <p>
            {t("Concedida", "Concedida")}:{" "}
            {new Date(item.grantedAt).toLocaleString(locale)}
          </p>
          <p>
            {t("Invitación de origen", "Invitación de orixe")}:{" "}
            {item.invitationId}
          </p>
          {item.revokedAt && (
            <p>
              {t("Revocada", "Revogada")}:{" "}
              {new Date(item.revokedAt).toLocaleString(locale)}
            </p>
          )}
          {item.active && item.expiresAt && (
            <MunicipalForm
              path={`${endpoint(m.id)}/administrators/${encodeURIComponent(item.accountId)}/make-indefinite`}
              label={t("Convertir en indefinido", "Converter en indefinido")}
              body={(d) => ({ reason: textField(d, "reason").trim() })}
              onSaved={() => saved()}
            >
              <Reason />
              <Checkbox
                required
                label={t(
                  "Confirmo el permiso sin caducidad",
                  "Confirmo o permiso sen caducidade",
                )}
              />
            </MunicipalForm>
          )}
          {!item.revokedAt && (
            <MunicipalForm
              path={`${endpoint(m.id)}/administrators/${encodeURIComponent(item.accountId)}/revoke`}
              danger
              label={t("Retirar administración", "Retirar administración")}
              body={(d) => ({ reason: textField(d, "reason").trim() })}
              onSaved={() => saved(item.accountId === account?.accountId)}
            >
              <p>
                {t(
                  "Se retira este rol y se invalidan sus invitaciones pendientes. No se cierra la cuenta ni se borran reservas.",
                  "Retírase este rol e invalídanse as súas invitacións pendentes. Non se pecha a conta nin se borran reservas.",
                )}
              </p>
              <Reason />
              <Checkbox
                required
                label={t(
                  "Confirmo la retirada ordinaria",
                  "Confirmo a retirada ordinaria",
                )}
              />
            </MunicipalForm>
          )}
        </section>
      )}
      <InvitationHistory kind="administrator" />
    </>
  );
}
function InvitationHistory({ kind }: { kind: "administrator" | "manager" }) {
  const m = useMunicipality();
  const { t, locale } = usePreferences();
  const saved = useAuthoritySaved();
  const query = useMunicipalPages<StaffInvitation>(
    `${endpoint(m.id)}/${kind}-invitations`,
  );
  const [selected, setSelected] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const item = rows.find((r) => r.invitationId === selected);
  const labels = {
    PENDING: t("Pendiente de aceptación", "Pendente de aceptación"),
    ACCEPTED: t("Aceptada", "Aceptada"),
    REVOKED: t("Revocada", "Revogada"),
    EXPIRED: t("Vencida", "Vencida"),
  };
  return (
    <section className={styles.section}>
      <h2>
        {kind === "manager"
          ? t(
              "Concesiones e invitaciones de gestores",
              "Concesións e invitacións de xestores",
            )
          : t(
              "Invitaciones de administradores",
              "Invitacións de administradores",
            )}
      </h2>
      <p>
        {t(
          "El historial no acredita permisos vigentes. Cada operación comprueba la cuenta, la concesión y su ámbito.",
          "O historial non acredita permisos vixentes. Cada operación comproba a conta, a concesión e o seu ámbito.",
        )}
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <SortableDataTable
            rows={rows}
            rowKey="invitationId"
            caption={t("Historial de invitaciones", "Historial de invitacións")}
            emptyMessage={t("No hay invitaciones.", "Non hai invitacións.")}
            columns={[
              {
                key: "accountId",
                label: t("Cuenta", "Conta"),
                sortable: false,
                render: (_, r) => (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelected(r.invitationId);
                      setReplacing(false);
                    }}
                  >
                    {r.accountId}
                  </Button>
                ),
              },
              {
                key: "acceptedAt",
                label: t("Último hecho registrado", "Último feito rexistrado"),
                sortable: false,
                render: (_, r) => labels[invitationEvent(r)],
              },
              {
                key: "expiresAt",
                label: t("Aceptar antes de", "Aceptar antes de"),
                sortable: false,
                render: (_, r) => new Date(r.expiresAt).toLocaleString(locale),
              },
            ]}
          />
          <More query={query} />
        </>
      )}
      {item && (
        <section className={styles.section} key={item.invitationId}>
          <h3>{t("Detalle de la invitación", "Detalle da invitación")}</h3>
          <p>
            {t("Identificador", "Identificador")}: {item.invitationId}
          </p>
          <p>
            {t("Destinatario", "Destinatario")}: {item.accountId}
          </p>
          <p>
            {t("Emisor", "Emisor")}: {item.invitedBy}
          </p>
          <p>
            {item.roleExpiresAt
              ? `${t("Permiso hasta", "Permiso ata")}: ${new Date(item.roleExpiresAt).toLocaleString(locale)}`
              : t(
                  "Permiso sin caducidad automática",
                  "Permiso sen caducidade automática",
                )}
          </p>
          {item.acceptedAt && (
            <p>
              {t("Aceptada", "Aceptada")}:{" "}
              {new Date(item.acceptedAt).toLocaleString(locale)}
            </p>
          )}
          {item.revokedAt && (
            <p>
              {t("Revocada", "Revogada")}:{" "}
              {new Date(item.revokedAt).toLocaleString(locale)}
            </p>
          )}
          {item.replacesInvitationId && (
            <p>
              {t("Sustituye la concesión", "Substitúe a concesión")}:{" "}
              {item.replacesInvitationId}
            </p>
          )}
          {item.permissions && (
            <ul>
              {item.permissions.map((p) => (
                <li key={`${p.operation}:${p.unitId}`}>
                  {t(...staffOperations[p.operation])} ·{" "}
                  {p.unitId
                    ? `${t("Unidad", "Unidade")}: ${p.unitId}`
                    : t("Todo el municipio", "Todo o municipio")}
                </li>
              ))}
            </ul>
          )}
          {!item.revokedAt && (kind === "manager" || !item.acceptedAt) && (
            <MunicipalForm
              path={`${endpoint(m.id)}/${kind}-invitations/${item.invitationId}/revoke`}
              danger
              label={
                kind === "manager" && item.acceptedAt
                  ? t("Revocar concesión", "Revogar concesión")
                  : t("Revocar invitación", "Revogar invitación")
              }
              body={(d) =>
                kind === "manager"
                  ? { reason: textField(d, "reason").trim() }
                  : {}
              }
              onSaved={() => saved()}
            >
              {kind === "manager" && <Reason />}
              <Checkbox
                required
                label={t("Confirmo la revocación", "Confirmo a revogación")}
              />
            </MunicipalForm>
          )}
          {kind === "administrator" && item.acceptedAt && (
            <p>
              {t(
                "Revocar una invitación aceptada no retira el rol. Utiliza la asignación del administrador.",
                "Revogar unha invitación aceptada non retira o rol. Utiliza a asignación do administrador.",
              )}
            </p>
          )}
          {kind === "manager" && canReplace(item) && (
            <>
              <Button
                variant="secondary"
                onClick={() => setReplacing(!replacing)}
              >
                {replacing
                  ? t("Cerrar sustitución", "Pechar substitución")
                  : t("Sustituir permisos", "Substituír permisos")}
              </Button>
              {replacing && (
                <StaffInvite
                  replacement={item}
                  onSaved={() => setReplacing(false)}
                />
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
function SecurityWithdrawal() {
  const m = useMunicipality();
  const { t } = usePreferences();
  const { account } = useSession();
  const saved = useAuthoritySaved();
  const [target, setTarget] = useState("");
  return (
    <section>
      <h2>
        {t(
          "Retirar acceso municipal por seguridad",
          "Retirar acceso municipal por seguridade",
        )}
      </h2>
      <p className={styles.notice}>
        {t(
          "Retira inmediatamente todos los permisos e invitaciones pendientes de la cuenta en este municipio, incluso los del último administrador. No suspende la cuenta global, no afecta a otros municipios ni cancela reservas. Si no queda un administrador habilitado, se requiere recuperación controlada por un operador.",
          "Retira inmediatamente todos os permisos e invitacións pendentes da conta neste municipio, incluso os do último administrador. Non suspende a conta global, non afecta a outros municipios nin cancela reservas. Se non queda un administrador habilitado, requírese recuperación controlada por un operador.",
        )}
      </p>
      <MunicipalForm
        path={`${endpoint(m.id)}/accounts/${encodeURIComponent(target.trim())}/revoke-access-for-security`}
        danger
        label={t(
          "Retirar acceso por seguridad",
          "Retirar acceso por seguridade",
        )}
        body={(d) => ({ reason: textField(d, "reason").trim() })}
        onSaved={() => saved(target.trim() === account?.accountId)}
      >
        <Input
          required
          maxLength={128}
          label={t("Identificador de cuenta", "Identificador de conta")}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Reason />
        <Checkbox
          required
          label={t(
            "Confirmo la retirada por seguridad en este municipio",
            "Confirmo a retirada por seguridade neste municipio",
          )}
        />
      </MunicipalForm>
    </section>
  );
}
