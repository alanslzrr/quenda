import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useContext, useEffect, useId, useState } from "react";
import { useLocation } from "react-router";
import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { Skeleton } from "../ui/skeleton/skeleton";
import { ApiError } from "./api";
import styles from "./feedback.module.css";
import { LinkButton } from "./link-button";
import { usePreferences } from "./preferences-provider";
import {
  ReauthenticationContext,
  ReauthenticationNoticeContext,
} from "./reauthentication-context";
import { retrySecondsLeft } from "./retry-after";

function useRetryWait(deadline: number | undefined) {
  const [, update] = useState(0);
  useEffect(() => {
    if (!retrySecondsLeft(deadline)) return;
    const timer = window.setInterval(() => {
      update((tick) => tick + 1);
      if (!retrySecondsLeft(deadline)) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return retrySecondsLeft(deadline);
}
export function Loading() {
  const { t } = usePreferences();
  return (
    <Skeleton label={t("Cargando contenido", "Cargando contido")} lines={3} />
  );
}
export function Failure({
  error,
  retry,
  retryLabel,
  retryBusy = false,
}: {
  error: unknown;
  retry?: () => void;
  retryLabel?: string;
  retryBusy?: boolean;
}) {
  const { t } = usePreferences();
  const client = useQueryClient();
  const location = useLocation();
  const expired = error instanceof ApiError && error.status === 401;
  const reauthenticate = useContext(ReauthenticationContext);
  const notice = useContext(ReauthenticationNoticeContext);
  const registration = useId();
  const register = notice?.register;
  const retryAt = error instanceof ApiError ? error.retryAt : undefined;
  const seconds = useRetryWait(retryAt);
  const waitId = useId();
  const needsFactor =
    error instanceof ApiError &&
    error.code === "REAUTHENTICATION_REQUIRED" &&
    reauthenticate;
  useEffect(() => {
    if (error instanceof ApiError && needsFactor && register)
      return register(registration);
  }, [needsFactor, register, registration, error]);
  // One explanation is enough: the page banner asks for the verification, the first waiting section says why,
  // and every other section only states what it is waiting for.
  if (needsFactor && notice?.first && notice.first !== registration)
    return (
      <p className={styles.waiting} role="status">
        <LockKeyhole size={14} aria-hidden="true" />
        {error instanceof ApiError
          ? error.message
          : t("Verifica el acceso", "Verifica o acceso")}
      </p>
    );
  if (needsFactor && notice)
    return (
      <section aria-label={t("Resolver el problema", "Resolver o problema")}>
        <Alert
          tone="warning"
          title={
            error instanceof ApiError
              ? error.message
              : t("Verifica el acceso", "Verifica o acceso")
          }
        />
        <p role="status">
          {notice.pending
            ? t(
                "Verifica el acceso en el aviso de seguridad para continuar.",
                "Verifica o acceso no aviso de seguridade para continuar.",
              )
            : t(
                "La verificación no envía la operación automáticamente. Revisa los datos y vuelve a enviarla si sigue pendiente.",
                "A verificación non envía a operación automaticamente. Revisa os datos e volve enviala se segue pendente.",
              )}
        </p>
        {notice.pending && (
          <LinkButton
            size="sm"
            to="#security-verification"
            onClick={(event) => {
              event.preventDefault();
              const target = document.getElementById("security-verification");
              target?.scrollIntoView({ block: "center" });
              target?.focus();
            }}
          >
            {t("Ir a la verificación", "Ir á verificación")}
          </LinkButton>
        )}
      </section>
    );
  return (
    <section aria-label={t("Resolver el problema", "Resolver o problema")}>
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
      {retryAt !== undefined &&
        (seconds > 0 ? (
          <p id={waitId} role="timer" aria-live="off">
            {t(
              `Podrás reintentar en ${seconds} s.`,
              `Poderás tentar de novo en ${seconds} s.`,
            )}
          </p>
        ) : (
          <p id={waitId} role="status">
            {t("Ya puedes reintentar.", "Xa podes tentar de novo.")}
          </p>
        ))}
      {expired ? (
        <LinkButton
          to={`/acceso?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
          onClick={() => client.setQueryData(["session"], null)}
        >
          {t("Volver a iniciar sesión", "Volver iniciar sesión")}
        </LinkButton>
      ) : needsFactor ? (
        <Button type="button" variant="secondary" onClick={reauthenticate}>
          {t("Verificar acceso", "Verificar acceso")}
        </Button>
      ) : (
        retry && (
          <Button
            type="button"
            variant="secondary"
            disabled={seconds > 0 || retryBusy}
            aria-describedby={retryAt !== undefined ? waitId : undefined}
            onClick={() => {
              if (!retryBusy && !retrySecondsLeft(retryAt)) retry();
            }}
          >
            {retryLabel ?? t("Reintentar", "Tentar de novo")}
            {/* The wait shows on the button itself, so a disabled retry reads as "not yet", not as broken. */}
            {seconds > 0 && (
              <span className={styles.wait} aria-hidden="true">
                {seconds} s
              </span>
            )}
          </Button>
        )
      )}
    </section>
  );
}
