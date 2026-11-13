import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { ActionForm } from "../../app/action";
import { usePreferences } from "../../app/preferences-provider";
import {
  ReauthenticationContext,
  ReauthenticationNoticeContext,
} from "../../app/reauthentication-context";
import { useSession } from "../../app/session";
import { Button } from "../../ui/button/button";
import { Dialog, DialogContent } from "../../ui/dialog/dialog";
import { FactorField, verifyFactor } from "./security";

export function MfaDialog() {
  const open = useContext(ReauthenticationContext);
  const { t } = usePreferences();
  return (
    <Button variant="secondary" size="sm" onClick={() => open?.()}>
      <ShieldCheck size={16} aria-hidden="true" />
      {t("Verificar acceso", "Verificar acceso")}
    </Button>
  );
}
export function MfaNotice() {
  const state = useContext(ReauthenticationNoticeContext);
  const { t } = usePreferences();
  if (!state?.pending) return null;
  return (
    <section
      id="security-verification"
      tabIndex={-1}
      role="status"
      aria-label={t("Verificación de seguridad", "Verificación de seguridade")}
      style={{
        padding: 16,
        marginBottom: 24,
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-control)",
      }}
    >
      <p>
        {t(
          "Confirma tu identidad para continuar. La sesión sigue abierta y tus cambios se conservan.",
          "Confirma a túa identidade para continuar. A sesión segue aberta e os teus cambios consérvanse.",
        )}
      </p>
      <MfaDialog />
    </section>
  );
}
export function MfaBoundary({ children }: { children: ReactNode }) {
  const { locale, t } = usePreferences();
  const { account, refresh } = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  // In registration order, so the first waiting section can carry the full explanation.
  const [requests, setRequests] = useState<string[]>([]);
  const register = useCallback((id: string) => {
    setRequests((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    return () => setRequests((previous) => previous.filter((x) => x !== id));
  }, []);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestVerification = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(true);
  }, []);

  return (
    <ReauthenticationContext.Provider value={requestVerification}>
      <ReauthenticationNoticeContext.Provider
        value={{ register, pending: requests.length > 0, first: requests[0] }}
      >
        {children}
      </ReauthenticationNoticeContext.Provider>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus.current?.isConnected
              ? returnFocus.current
              : document.getElementById("content")
            )?.focus();
          }}
          title={t("Verificar acceso", "Verificar acceso")}
          closeLabel={t("Cerrar", "Pechar")}
          description={t(
            "La verificación dura cinco minutos. Tus cambios se conservan; ninguna operación se ejecutará automáticamente.",
            "A verificación dura cinco minutos. Os teus cambios consérvanse; ningunha operación se executará automaticamente.",
          )}
        >
          <ActionForm
            label={t("Verificar acceso", "Verificar acceso")}
            submit={async (data) => {
              await verifyFactor(data, locale);
              await refresh();
              await client.invalidateQueries({
                queryKey: ["private", account?.accountId],
              });
              setRequests([]);
              setOpen(false);
            }}
          >
            <FactorField />
          </ActionForm>
        </DialogContent>
      </Dialog>
    </ReauthenticationContext.Provider>
  );
}
