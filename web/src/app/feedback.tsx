import { useContext } from "react";
import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { Skeleton } from "../ui/skeleton/skeleton";
import { ApiError } from "./api";
import { usePreferences } from "./preferences-provider";
import { ReauthenticationContext } from "./reauthentication-context";
export function Loading() {
  const { t } = usePreferences();
  return (
    <Skeleton label={t("Cargando contenido", "Cargando contido")} lines={3} />
  );
}
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const { t } = usePreferences();
  const reauthenticate = useContext(ReauthenticationContext);
  const needsFactor =
    error instanceof ApiError &&
    error.code === "REAUTHENTICATION_REQUIRED" &&
    reauthenticate;
  return (
    <div role="alert">
      <Alert
        tone="danger"
        title={
          error instanceof ApiError
            ? error.message
            : t(
                "No se pudo cargar el contenido.",
                "Non se puido cargar o contido.",
              )
        }
      />
      {needsFactor ? (
        <Button type="button" variant="secondary" onClick={reauthenticate}>
          {t("Verificar MFA", "Verificar MFA")}
        </Button>
      ) : (
        retry && (
          <Button type="button" variant="secondary" onClick={retry}>
            {t("Reintentar", "Tentar de novo")}
          </Button>
        )
      )}
    </div>
  );
}
