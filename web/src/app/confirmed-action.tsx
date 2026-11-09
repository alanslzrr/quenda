import { type ReactNode, useState } from "react";
import { Button } from "../ui/button/button";
import { Checkbox } from "../ui/checkbox/checkbox";
import { ActionForm } from "./action";
import { ApiError, api } from "./api";
import { usePreferences } from "./preferences-provider";
// Persist only an account/scope-bound uncertainty marker, never the request or downloaded content.
// These endpoints have no idempotent replay contract.
export function ConfirmedAction<T>({
  storageKey: key,
  path,
  body,
  label,
  children,
  onResult,
  danger = false,
  timeoutMs = 15000,
}: {
  storageKey: string;
  path: string;
  body: (data: FormData) => unknown;
  label: string;
  children: ReactNode;
  onResult: (result: T) => void | Promise<void>;
  danger?: boolean;
  /** Large downloads are slow without being uncertain; the default suits ordinary commands. */
  timeoutMs?: number;
}) {
  const { locale, t } = usePreferences();
  const [uncertain, setUncertain] = useState(() => {
    try {
      return sessionStorage.getItem(key) !== null;
    } catch {
      return true;
    }
  });
  const [reviewed, setReviewed] = useState(false);
  return (
    <>
      <ActionForm
        label={label}
        danger={danger}
        disabled={uncertain}
        resetOnSuccess={false}
        submit={async (d) => {
          const content = JSON.stringify(body(d));
          try {
            sessionStorage.setItem(key, "pending");
          } catch {
            throw new ApiError(
              0,
              "STORAGE_UNAVAILABLE",
              t(
                "No se puede proteger la comprobación de esta operación en la pestaña.",
                "Non se pode protexer a comprobación desta operación na pestana.",
              ),
            );
          }
          let result: T;
          try {
            result = await api<T>(
              path,
              {
                method: "POST",
                body: content,
                signal: AbortSignal.timeout(timeoutMs),
              },
              locale,
            );
          } catch (error) {
            if (
              error instanceof ApiError &&
              error.status >= 400 &&
              error.status < 500
            ) {
              sessionStorage.removeItem(key);
              throw error;
            }
            setUncertain(true);
            throw new ApiError(
              0,
              "UNCERTAIN_RESULT",
              t(
                "No se recibió confirmación. No repitas la operación hasta comprobar su resultado en este ámbito o mediante revisión administrativa.",
                "Non se recibiu confirmación. Non repitas a operación ata comprobar o seu resultado neste ámbito ou mediante revisión administrativa.",
              ),
            );
          }
          sessionStorage.removeItem(key);
          await onResult(result);
        }}
      >
        {children}
      </ActionForm>
      {uncertain && (
        <section>
          <p role="alert">
            {t(
              "Hay una operación sin confirmar en este ámbito. No se reenviará al recargar ni al verificar MFA.",
              "Hai unha operación sen confirmar neste ámbito. Non se reenviará ao recargar nin ao verificar MFA.",
            )}
          </p>
          <Checkbox
            checked={reviewed}
            onCheckedChange={(v) => setReviewed(v === true)}
            label={t(
              "He comprobado el resultado antes de iniciar otra operación",
              "Comprobei o resultado antes de iniciar outra operación",
            )}
          />
          <Button
            disabled={!reviewed}
            variant="secondary"
            onClick={() => {
              sessionStorage.removeItem(key);
              setUncertain(false);
              setReviewed(false);
            }}
          >
            {t("Cerrar comprobación", "Pechar comprobación")}
          </Button>
        </section>
      )}
    </>
  );
}
