import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";

/** Platform accounts show their name, never their e-mail; the identifier stays visible to tell homonyms apart. */
export function PlatformAccount({
  id,
  name,
}: {
  id: string;
  name: string | null | undefined;
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
        {name || id}
        {own ? t(" (tu cuenta)", " (a túa conta)") : ""}
      </span>
      {name && (
        <small style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
          {id}
        </small>
      )}
    </span>
  );
}
