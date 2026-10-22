import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import "./ui/foundation.css";
import "./ui/fonts.css";
import "./ui/accessibility.css";
import "./app/global.css";
import { Layout } from "./app/layout";
import {
  PreferencesProvider,
  usePreferences,
} from "./app/preferences-provider";
import { createQueryClient } from "./app/query";
import { SessionProvider } from "./app/session";
import { ThemeProvider, useMunicipalTheme } from "./app/theme-provider";
import { Directory } from "./features/catalog/directory";

const MunicipalityPage = lazy(() =>
  import("./features/catalog/municipality").then((m) => ({
    default: m.MunicipalityPage,
  })),
);
const UnitPage = lazy(() =>
  import("./features/catalog/unit").then((m) => ({ default: m.UnitPage })),
);
const SignIn = lazy(() =>
  import("./features/account/sign-in").then((m) => ({ default: m.SignIn })),
);
const Profile = lazy(() =>
  import("./features/account/profile").then((m) => ({ default: m.Profile })),
);

import { Loading } from "./app/feedback";

const client = createQueryClient();
function Missing() {
  useMunicipalTheme(undefined);
  const { t } = usePreferences();
  return (
    <>
      <h1>{t("Página no encontrada", "Páxina non atopada")}</h1>
      <Link to="/">{t("Volver al inicio", "Volver ao inicio")}</Link>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={client}>
        <SessionProvider>
          <PreferencesProvider>
            <ThemeProvider>
              <BrowserRouter>
                <Suspense fallback={<Loading />}>
                  <Routes>
                    <Route element={<Layout />}>
                      <Route index element={<Directory />} />
                      <Route
                        path="municipios/:tenantId"
                        element={<MunicipalityPage />}
                      />
                      <Route
                        path="municipios/:tenantId/unidades/:unitId"
                        element={<UnitPage />}
                      />
                      <Route path="acceso" element={<SignIn />} />
                      <Route
                        path="registro"
                        element={<SignIn key="register" register />}
                      />
                      <Route path="perfil" element={<Profile />} />
                      <Route path="*" element={<Missing />} />
                    </Route>
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </ThemeProvider>
          </PreferencesProvider>
        </SessionProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
