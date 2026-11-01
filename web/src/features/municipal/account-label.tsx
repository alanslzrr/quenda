import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
export type AccountLabelValue = { name: string; email: string } | null;
export function accountText(
  label: AccountLabelValue | undefined,
  fallback: string,
) {
  return label
    ? `${label.name.trim() || label.email} · ${label.email}`
    : fallback;
}
export function AccountLabel({
  id,
  label,
}: {
  id: string;
  label?: AccountLabelValue;
}) {
  const { account } = useSession();
  const { t } = usePreferences();
  const own = id === account?.accountId;
  return (
    <span
      style={{
        display: "inline-grid",
        textAlign: "start",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
      }}
    >
      <span>
        {label?.name.trim() ||
          label?.email ||
          (own
            ? account.email
            : t("Cuenta no disponible", "Conta non dispoñible"))}
        {own ? t(" (tu cuenta)", " (a túa conta)") : ""}
      </span>
      {label?.name.trim() && <small>{label.email}</small>}
    </span>
  );
}
