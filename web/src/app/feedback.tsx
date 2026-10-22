import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { Skeleton } from "../ui/skeleton/skeleton";
import { ApiError } from "./api";
import { usePreferences } from "./preferences-provider";
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
      {retry && (
        <Button variant="secondary" onClick={retry}>
          {t("Reintentar", "Tentar de novo")}
        </Button>
      )}
    </div>
  );
}
