import { Component, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { isChunkError, mayReloadOnce } from "./chunk-reload.ts";
import { usePreferences } from "./preferences-provider";
import { browserStorage } from "./storage.ts";

export function reloadForNewVersion() {
  if (mayReloadOnce(browserStorage("session"), Date.now()))
    window.location.reload();
}

function Fallback({ chunk }: { chunk: boolean }) {
  const { t } = usePreferences();
  return (
    <main id="content" tabIndex={-1} style={{ padding: "2rem 1rem" }}>
      <Alert
        tone="danger"
        title={
          chunk
            ? t("Hay una versión nueva", "Hai unha versión nova")
            : t(
                "Algo ha fallado al mostrar esta página",
                "Algo fallou ao mostrar esta páxina",
              )
        }
      >
        <p>
          {chunk
            ? t(
                "Recarga para continuar. No se ha enviado ni perdido ninguna operación.",
                "Recarga para continuar. Non se enviou nin se perdeu ningunha operación.",
              )
            : t(
                "Puedes recargar la página o volver al inicio. Si una operación estaba en curso, comprueba su resultado antes de repetirla.",
                "Podes recargar a páxina ou volver ao inicio. Se había unha operación en curso, comproba o seu resultado antes de repetila.",
              )}
        </p>
      </Alert>
      <p style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
        <Button type="button" onClick={() => window.location.reload()}>
          {t("Recargar", "Recargar")}
        </Button>
        <a href="/">{t("Volver al inicio", "Volver ao inicio")}</a>
      </p>
    </main>
  );
}

class Catcher extends Component<
  { children: ReactNode },
  { failed: boolean; chunk: boolean }
> {
  state = { failed: false, chunk: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, chunk: isChunkError(error) };
  }
  componentDidCatch(error: unknown) {
    // Only the error name reaches the console; messages may echo user input.
    console.error(
      "Render failure",
      error instanceof Error ? error.name : typeof error,
    );
    if (isChunkError(error)) reloadForNewVersion();
  }
  render() {
    return this.state.failed ? (
      <Fallback chunk={this.state.chunk} />
    ) : (
      this.props.children
    );
  }
}

/** Contains render and lazy-chunk failures; each navigation gets a fresh boundary. */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <Catcher key={location.key}>{children}</Catcher>;
}
