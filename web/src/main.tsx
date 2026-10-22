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

const AccountLayout = lazy(() =>
  import("./features/account/shared").then((m) => ({
    default: m.AccountLayout,
  })),
);
const RequireAccount = lazy(() =>
  import("./features/account/shared").then((m) => ({
    default: m.RequireAccount,
  })),
);
const PersonalDetails = lazy(() =>
  import("./features/account/personal").then((m) => ({
    default: m.PersonalDetails,
  })),
);
const AccountSecurity = lazy(() =>
  import("./features/account/security").then((m) => ({
    default: m.AccountSecurity,
  })),
);
const AccountPrivacy = lazy(() =>
  import("./features/account/privacy").then((m) => ({
    default: m.AccountPrivacy,
  })),
);
const RecoveryRequest = lazy(() =>
  import("./features/account/recovery").then((m) => ({
    default: m.RecoveryRequest,
  })),
);
const ResetPassword = lazy(() =>
  import("./features/account/recovery").then((m) => ({
    default: m.ResetPassword,
  })),
);
const ReactivateAccount = lazy(() =>
  import("./features/account/recovery").then((m) => ({
    default: m.ReactivateAccount,
  })),
);
const EmailChangeConfirmation = lazy(() =>
  import("./features/account/recovery").then((m) => ({
    default: m.EmailChangeConfirmation,
  })),
);
const Invitations = lazy(() =>
  import("./features/account/invitations").then((m) => ({
    default: m.Invitations,
  })),
);
const Checkout = lazy(() =>
  import("./features/reservations/checkout").then((m) => ({
    default: m.Checkout,
  })),
);
const ReservationDetail = lazy(() =>
  import("./features/reservations/detail").then((m) => ({
    default: m.ReservationDetail,
  })),
);
const ReservationHistory = lazy(() =>
  import("./features/reservations/history").then((m) => ({
    default: m.ReservationHistory,
  })),
);
const Notices = lazy(() =>
  import("./features/reservations/history").then((m) => ({
    default: m.Notices,
  })),
);
const ModifyReservation = lazy(() =>
  import("./features/reservations/modify").then((m) => ({
    default: m.ModifyReservation,
  })),
);
const CommandRecovery = lazy(() =>
  import("./features/reservations/shared").then((m) => ({
    default: m.CommandRecovery,
  })),
);
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
                      <Route
                        path="recuperar"
                        element={<RecoveryRequest key="reset" kind="reset" />}
                      />
                      <Route
                        path="reactivar"
                        element={
                          <RecoveryRequest key="reactivate" kind="reactivate" />
                        }
                      />
                      <Route
                        path="verificar-correo"
                        element={<RecoveryRequest key="verify" kind="verify" />}
                      />
                      <Route
                        path="account/reset-password"
                        element={<ResetPassword />}
                      />
                      <Route
                        path="account/reactivation"
                        element={<ReactivateAccount />}
                      />
                      <Route
                        path="account/email-change/approve"
                        element={
                          <EmailChangeConfirmation
                            key="approve"
                            step="approve"
                          />
                        }
                      />
                      <Route
                        path="account/email-change/confirm"
                        element={
                          <EmailChangeConfirmation
                            key="confirm"
                            step="confirm"
                          />
                        }
                      />
                      <Route element={<RequireAccount />}>
                        <Route
                          path="municipios/:tenantId/unidades/:unitId/reservar"
                          element={<Checkout />}
                        />
                        <Route
                          path="reservas"
                          element={<ReservationHistory />}
                        />
                        <Route path="avisos" element={<Notices />} />
                        <Route
                          path="reservas/recuperacion"
                          element={<CommandRecovery />}
                        />
                        <Route
                          path="reservas/:tenantId/:reservationId"
                          element={<ReservationDetail />}
                        />
                        <Route
                          path="reservas/:tenantId/:reservationId/modificar"
                          element={<ModifyReservation />}
                        />
                        <Route
                          path="reservas/:tenantId/:reservationId/confirmar"
                          element={<Checkout />}
                        />
                        <Route path="perfil" element={<AccountLayout />}>
                          <Route index element={<Profile />} />
                          <Route
                            path="invitaciones"
                            element={<Invitations />}
                          />
                          <Route path="datos" element={<PersonalDetails />} />
                          <Route
                            path="seguridad"
                            element={<AccountSecurity />}
                          />
                          <Route
                            path="privacidad"
                            element={<AccountPrivacy />}
                          />
                        </Route>
                      </Route>
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
