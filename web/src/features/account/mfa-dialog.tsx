import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { type ReactNode, useContext, useRef, useState } from "react";
import { ActionForm } from "../../app/action";
import { usePreferences } from "../../app/preferences-provider";
import { ReauthenticationContext } from "../../app/reauthentication-context";
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
      {t("Verificar MFA", "Verificar MFA")}
    </Button>
  );
}
export function MfaBoundary({ children }: { children: ReactNode }) {
  const { locale, t } = usePreferences();
  const { account, refresh } = useSession();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <ReauthenticationContext.Provider
      value={() => {
        returnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setOpen(true);
      }}
    >
      {children}
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
            label={t("Verificar MFA", "Verificar MFA")}
            submit={async (data) => {
              await verifyFactor(data, locale);
              await refresh();
              await client.invalidateQueries({
                queryKey: ["private", account?.accountId, "municipal"],
              });
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
