import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./ui/foundation.css";
import "./ui/fonts.css";
import "./ui/accessibility.css";
import "./app/global.css";
import { RouteBoundary, reloadForNewVersion } from "./app/error-boundary";
import { Layout } from "./app/layout";
import { NotFound } from "./app/not-found";
import { PreferencesProvider } from "./app/preferences-provider";
import { createQueryClient } from "./app/query";
import { SessionProvider } from "./app/session";
import { ThemeProvider } from "./app/theme-provider";
import { Home } from "./features/catalog/directory";

const MunicipalityPage = lazy(() =>
  import("./features/catalog/municipality").then((m) => ({
    default: m.MunicipalityPage,
  })),
);
const SearchPage = lazy(() =>
  import("./features/catalog/municipality").then((m) => ({
    default: m.SearchPage,
  })),
);
const FacilityPage = lazy(() =>
  import("./features/catalog/facility").then((m) => ({
    default: m.FacilityPage,
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
  import("./features/reservations/notices").then((m) => ({
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
const Administration = lazy(() =>
  import("./features/municipal/shared").then((m) => ({
    default: m.Administration,
  })),
);
const MunicipalLayout = lazy(() =>
  import("./features/municipal/shared").then((m) => ({
    default: m.MunicipalLayout,
  })),
);
const Catalog = lazy(() =>
  import("./features/municipal/catalog").then((m) => ({ default: m.Catalog })),
);
const ResourcePage = lazy(() =>
  import("./features/municipal/catalog").then((m) => ({
    default: m.ResourcePage,
  })),
);
const NewUnit = lazy(() =>
  import("./features/municipal/catalog").then((m) => ({ default: m.NewUnit })),
);
const BookingPolicy = lazy(() =>
  import("./features/municipal/configuration").then((m) => ({
    default: m.BookingPolicy,
  })),
);
const MunicipalAppearance = lazy(() =>
  import("./features/municipal/appearance").then((m) => ({
    default: m.MunicipalAppearance,
  })),
);
const Agenda = lazy(() =>
  import("./features/municipal/agenda").then((m) => ({ default: m.Agenda })),
);
const AdministrativeReservation = lazy(() =>
  import("./features/municipal/agenda").then((m) => ({
    default: m.AdministrativeReservation,
  })),
);
const MunicipalStaff = lazy(() =>
  import("./features/municipal/staff").then((m) => ({
    default: m.MunicipalStaff,
  })),
);
const Agreements = lazy(() =>
  import("./features/collaboration/agreements").then((m) => ({
    default: m.Agreements,
  })),
);
const NewAgreement = lazy(() =>
  import("./features/collaboration/agreements").then((m) => ({
    default: m.NewAgreement,
  })),
);
const AgreementPage = lazy(() =>
  import("./features/collaboration/agreements").then((m) => ({
    default: m.AgreementPage,
  })),
);
const Credentials = lazy(() =>
  import("./features/collaboration/credentials").then((m) => ({
    default: m.Credentials,
  })),
);
const IssueCredential = lazy(() =>
  import("./features/collaboration/credentials").then((m) => ({
    default: m.IssueCredential,
  })),
);
const Reopening = lazy(() =>
  import("./features/collaboration/reopening").then((m) => ({
    default: m.Reopening,
  })),
);
const MunicipalPrivacy = lazy(() =>
  import("./features/privacy/page").then((m) => ({
    default: m.MunicipalPrivacy,
  })),
);
const GlobalPrivacy = lazy(() =>
  import("./features/privacy/page").then((m) => ({ default: m.GlobalPrivacy })),
);
const Platform = lazy(() =>
  import("./features/platform/page").then((m) => ({ default: m.Platform })),
);
const UsageAnalyticsScreen = lazy(() =>
  import("./features/analytics/screen").then((m) => ({
    default: m.UsageAnalyticsScreen,
  })),
);
const ReservationExport = lazy(() =>
  import("./features/reporting/export").then((m) => ({
    default: m.ReservationExport,
  })),
);
const MonthlyReport = lazy(() =>
  import("./features/reporting/monthly").then((m) => ({
    default: m.MonthlyReport,
  })),
);
const MonthlyReview = lazy(() =>
  import("./features/reporting/review").then((m) => ({
    default: m.MonthlyReview,
  })),
);
const LegalPage = lazy(() =>
  import("./features/legal/legal-page").then((m) => ({ default: m.LegalPage })),
);
const MunicipalNotices = lazy(() =>
  import("./features/legal/notice-editor").then((m) => ({
    default: m.MunicipalNotices,
  })),
);
const client = createQueryClient();
// A stale tab asks for chunks that a newer deployment removed.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadForNewVersion();
});
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
                <RouteBoundary>
                  <Suspense fallback={<Loading />}>
                    <Routes>
                      <Route element={<Layout />}>
                        <Route index element={<Home />} />
                        <Route path="reservar" element={<Home />} />
                        <Route
                          path="municipios/:tenantId"
                          element={<MunicipalityPage />}
                        />
                        <Route
                          path="municipios/:tenantId/horarios"
                          element={<SearchPage />}
                        />
                        <Route
                          path="municipios/:tenantId/instalaciones/:facilityId"
                          element={<FacilityPage />}
                        />
                        <Route
                          path="municipios/:tenantId/unidades/:unitId"
                          element={<UnitPage />}
                        />
                        <Route
                          path="privacidad"
                          element={<LegalPage kind="privacy" />}
                        />
                        <Route
                          path="aviso-legal"
                          element={<LegalPage kind="legal" />}
                        />
                        <Route
                          path="accesibilidad"
                          element={<LegalPage kind="accessibility" />}
                        />
                        <Route
                          path="municipios/:tenantId/privacidad"
                          element={<LegalPage kind="privacy" />}
                        />
                        <Route
                          path="municipios/:tenantId/aviso-legal"
                          element={<LegalPage kind="legal" />}
                        />
                        <Route
                          path="municipios/:tenantId/accesibilidad"
                          element={<LegalPage kind="accessibility" />}
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
                            <RecoveryRequest
                              key="reactivate"
                              kind="reactivate"
                            />
                          }
                        />
                        <Route
                          path="verificar-correo"
                          element={
                            <RecoveryRequest key="verify" kind="verify" />
                          }
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
                          <Route path="plataforma" element={<Platform />} />
                          <Route
                            path="plataforma/gestion/:section"
                            element={<Platform />}
                          />
                          <Route
                            path="plataforma/privacidad/:section?"
                            element={<GlobalPrivacy />}
                          />
                          <Route
                            path="administracion"
                            element={<Administration />}
                          />
                          <Route
                            path="administracion/:tenantId"
                            element={<MunicipalLayout />}
                          >
                            <Route index element={<Catalog />} />
                            <Route
                              path="uso-de-los-espacios"
                              element={<UsageAnalyticsScreen />}
                            />
                            {/* The former indicators address keeps working. */}
                            <Route
                              path="indicadores"
                              element={
                                <Navigate to="../uso-de-los-espacios" replace />
                              }
                            />
                            <Route
                              path="exportaciones"
                              element={<ReservationExport />}
                            />
                            <Route
                              path="informes"
                              element={<MonthlyReport />}
                            />
                            <Route
                              path="informes/revision"
                              element={<MonthlyReview />}
                            />
                            <Route
                              path="privacidad/:section?"
                              element={<MunicipalPrivacy />}
                            />
                            <Route
                              path="instalaciones/:resourceId"
                              element={<ResourcePage />}
                            />
                            <Route
                              path="instalaciones/:resourceId/nueva-unidad"
                              element={<NewUnit />}
                            />
                            <Route
                              path="unidades/:resourceId"
                              element={<ResourcePage unit />}
                            />
                            <Route
                              path="condiciones"
                              element={<BookingPolicy />}
                            />
                            <Route
                              path="apariencia"
                              element={<MunicipalAppearance />}
                            />
                            <Route path="convenios" element={<Agreements />} />
                            <Route
                              path="convenios/nuevo"
                              element={<NewAgreement />}
                            />
                            <Route
                              path="convenios/:agreementId/versiones/:version"
                              element={<AgreementPage />}
                            />
                            <Route
                              path="convenios/:agreementId/versiones/:version/nueva-version"
                              element={<AgreementPage edit />}
                            />
                            <Route
                              path="convenios/:agreementId/versiones/:version/acreditar"
                              element={<IssueCredential />}
                            />
                            <Route
                              path="convenios/unidades/:unitId/reapertura"
                              element={<Reopening />}
                            />
                            <Route
                              path="acreditaciones"
                              element={<Credentials />}
                            />
                            <Route
                              path="textos-legales"
                              element={<MunicipalNotices />}
                            />
                            <Route path="agenda" element={<Agenda />} />
                            <Route
                              path="personal/:section?"
                              element={<MunicipalStaff />}
                            />
                            <Route
                              path="reservas/:reservationId"
                              element={<AdministrativeReservation />}
                            />
                          </Route>

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
                        <Route path="*" element={<NotFound />} />
                      </Route>
                    </Routes>
                  </Suspense>
                </RouteBoundary>
              </BrowserRouter>
            </ThemeProvider>
          </PreferencesProvider>
        </SessionProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
