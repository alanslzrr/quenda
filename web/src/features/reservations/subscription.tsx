import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarSync, Check, Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { ActionForm } from "../../app/action";
import { api } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { Alert } from "../../ui/alert/alert";
import { Button } from "../../ui/button/button";
import button from "../../ui/button/button.module.css";
import { Dialog, DialogContent, DialogTrigger } from "../../ui/dialog/dialog";
import { Input } from "../../ui/input/input";
import styles from "./reservations.module.css";

interface Status {
  active: boolean;
  createdAt: string | null;
}
interface Created {
  url: string;
  webcalUrl: string;
  createdAt: string;
}

/**
 * Both ways of taking reservations to a calendar application, behind one
 * button: a one-off .ics download and a personal URL that calendar
 * applications refresh by themselves. The URL is kept here, outside the
 * dialog, so closing and reopening it in the same visit still shows it.
 */
export function CalendarActions({ download }: { download: boolean }) {
  const { locale, t } = usePreferences();
  // The URL exists only in this response; it is never stored in the browser.
  const [created, setCreated] = useState<Created | null>(null);
  // The withdraw form disappears with the subscription, so its confirmation lives here.
  const [withdrawn, setWithdrawn] = useState(false);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <CalendarSync size={16} aria-hidden="true" />
          {t("Añadir a mi calendario", "Engadir ao meu calendario")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className={styles.calendarDialog}
        closeLabel={t("Cerrar", "Pechar")}
        title={t("Añadir a tu calendario", "Engadir ao teu calendario")}
        description={t(
          "Lleva tus próximas reservas confirmadas a Google Calendar, Outlook o Calendario de Apple.",
          "Leva as túas próximas reservas confirmadas a Google Calendar, Outlook ou Calendario de Apple.",
        )}
      >
        <div className={styles.calendarOptions}>
          {download && (
            <section className={styles.calendarOption}>
              <h3>{t("Descargar una vez", "Descargar unha vez")}</h3>
              <p>
                {t(
                  "Un archivo .ics con tus próximas reservas. No se actualiza solo: vuelve a descargarlo si cambian.",
                  "Un ficheiro .ics coas túas próximas reservas. Non se actualiza só: volve descargalo se cambian.",
                )}
              </p>
              <a
                className={`${button.button} ${button.secondary} ${styles.calendarDownload}`}
                href={`/api/me/reservations/calendar.ics?lang=${locale}`}
                download
              >
                <Download size={16} aria-hidden="true" />
                {t(
                  "Descargar mis próximas reservas (.ics)",
                  "Descargar as miñas próximas reservas (.ics)",
                )}
              </a>
            </section>
          )}
          <section className={styles.calendarOption}>
            <h3>
              {t("Sincronizar automáticamente", "Sincronizar automaticamente")}
            </h3>
            <CalendarSubscription
              created={created}
              setCreated={setCreated}
              withdrawn={withdrawn}
              setWithdrawn={setWithdrawn}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A personal calendar URL that calendar applications refresh by themselves. */
function CalendarSubscription({
  created,
  setCreated,
  withdrawn,
  setWithdrawn,
}: {
  created: Created | null;
  setCreated: (value: Created | null) => void;
  withdrawn: boolean;
  setWithdrawn: (value: boolean) => void;
}) {
  const { locale, t } = usePreferences();
  const { account } = useSession();
  const client = useQueryClient();
  const key = ["private", account?.accountId, "calendar-subscription"];
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<Status>("/api/me/calendar-subscription", { signal }, locale),
  });
  const active = status.data?.active ?? false;
  const since = status.data?.createdAt
    ? new Date(status.data.createdAt).toLocaleDateString(
        locale === "gl" ? "gl-ES" : "es-ES",
        { dateStyle: "long" },
      )
    : "";
  return (
    <>
      <p>
        {t(
          "Una dirección personal que Google Calendar, Outlook o Calendario de Apple consultan cada cierto tiempo. Muestra tus próximas reservas confirmadas y retira las canceladas sin que tengas que descargar nada. La aplicación de calendario decide cada cuánto se actualiza.",
          "Un enderezo persoal que Google Calendar, Outlook ou Calendario de Apple consultan cada certo tempo. Mostra as túas próximas reservas confirmadas e retira as canceladas sen que teñas que descargar nada. A aplicación de calendario decide cada canto se actualiza.",
        )}
      </p>
      <p>
        {t(
          "Quien tenga la dirección verá esas reservas sin iniciar sesión. No la compartas; si crees que otra persona la tiene, genera una nueva o retírala.",
          "Quen teña o enderezo verá esas reservas sen iniciar sesión. Non o compartas; se cres que outra persoa o ten, xera un novo ou retírao.",
        )}
      </p>
      {status.isPending ? (
        <Loading />
      ) : status.isError ? (
        <Failure error={status.error} retry={() => void status.refetch()} />
      ) : (
        <>
          {active && !created && (
            <p>
              {t(
                `Tienes una suscripción activa desde el ${since}. Por seguridad, la dirección solo se muestra al crearla.`,
                `Tes unha subscrición activa desde o ${since}. Por seguridade, o enderezo só se mostra ao crealo.`,
              )}
            </p>
          )}
          {created && <CreatedUrl created={created} />}
          <p role="status">
            {withdrawn && !active
              ? t(
                  "Suscripción retirada. La dirección ya no funciona.",
                  "Subscrición retirada. O enderezo xa non funciona.",
                )
              : ""}
          </p>
          <ActionForm
            label={
              active
                ? t("Generar una dirección nueva", "Xerar un enderezo novo")
                : t(
                    "Crear dirección de suscripción",
                    "Crear enderezo de subscrición",
                  )
            }
            resetOnSuccess={false}
            submit={async () => {
              setCreated(null);
              setWithdrawn(false);
              const result = await api<Created>(
                "/api/me/calendar-subscription",
                { method: "POST", body: JSON.stringify({ lang: locale }) },
                locale,
              );
              setCreated(result);
              await client.invalidateQueries({ queryKey: key });
            }}
          >
            {active && (
              <p>
                {t(
                  "La dirección anterior dejará de funcionar y tendrás que añadir la nueva en tu aplicación de calendario.",
                  "O enderezo anterior deixará de funcionar e terás que engadir o novo na túa aplicación de calendario.",
                )}
              </p>
            )}
          </ActionForm>
          {active && (
            <ActionForm
              label={t("Retirar la suscripción", "Retirar a subscrición")}
              danger
              submit={async () => {
                await api<{ revoked: boolean }>(
                  "/api/me/calendar-subscription/revoke",
                  { method: "POST" },
                  locale,
                );
                setCreated(null);
                setWithdrawn(true);
                await client.invalidateQueries({ queryKey: key });
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function CreatedUrl({ created }: { created: Created }) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Alert tone="success" title={t("Dirección creada", "Enderezo creado")}>
      <p>
        {t(
          "Cópiala ahora: no se volverá a mostrar. En Google Calendar, añádela en «Otros calendarios» › «Desde URL».",
          "Cópiao agora: non se volverá mostrar. En Google Calendar, engádeo en «Outros calendarios» › «Desde URL».",
        )}
      </p>
      <div className={styles.subscriptionUrl}>
        <Input
          label={t("Dirección de suscripción", "Enderezo de subscrición")}
          value={created.url}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(created.url)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
          aria-label={t("Copiar la dirección", "Copiar o enderezo")}
        >
          {copied ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
        </button>
        <span role="status" className={styles.srOnly}>
          {copied ? t("Dirección copiada", "Enderezo copiado") : ""}
        </span>
      </div>
      <p>
        <a href={created.webcalUrl}>
          {t(
            "Abrir en mi aplicación de calendario",
            "Abrir na miña aplicación de calendario",
          )}
        </a>
      </p>
    </Alert>
  );
}
