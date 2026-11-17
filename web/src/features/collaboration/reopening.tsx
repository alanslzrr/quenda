import { useParams } from "react-router";
import { textField } from "../../app/action";
import { Failure, Loading } from "../../app/feedback";
import { BackLink } from "../../app/link-button";
import { usePreferences } from "../../app/preferences-provider";
import { Checkbox } from "../../ui/checkbox/checkbox";
import { ManagementPage } from "../municipal/page";
import {
  Denied,
  endpoint,
  Reason,
  useMunicipality,
  useMunicipalQuery,
} from "../municipal/shared";
import { PendingLink } from "../reservations/shared";
import { CollaborationAction } from "./action";
import { agreementPath } from "./model";
export function Reopening() {
  return useMunicipality().administrator ? <Restriction /> : <Denied />;
}
function Restriction() {
  const m = useMunicipality();
  const { unitId = "" } = useParams();
  const { t } = usePreferences();
  const path = `${endpoint(m.id)}/units/${unitId}/agreement-restriction`;
  const query = useMunicipalQuery<{
    unitId: string;
    restriction: null | {
      agreementId: string;
      version: number;
      hasRemainingAssignment: boolean;
    };
  }>(path);
  if (query.isPending) return <Loading />;
  if (query.isError || !query.data)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const r = query.data.restriction;
  return (
    <ManagementPage
      title={t("Vinculación de la unidad", "Vinculación da unidade")}
      breadcrumb={
        <BackLink to={agreementPath(m.id)}>
          {t("Convenios", "Convenios")}
        </BackLink>
      }
      description={t(
        "Retirar la vinculación no publica la unidad ni modifica horarios, reservas o bloqueos.",
        "Retirar a vinculación non publica a unidade nin modifica horarios, reservas ou bloqueos.",
      )}
    >
      <PendingLink />
      {!r ? (
        <p role="status">
          {t(
            "Sin vinculación restrictiva registrada.",
            "Sen vinculación restritiva rexistrada.",
          )}
        </p>
      ) : (
        <>
          <p>
            {t("Convenio", "Convenio")}: {r.agreementId} ·{" "}
            {t("versión", "versión")} {r.version}
          </p>
          {r.hasRemainingAssignment ? (
            <p>
              {t(
                "No puede retirarse: existen adscripciones vigentes o futuras.",
                "Non pode retirarse: existen adscricións vixentes ou futuras.",
              )}
            </p>
          ) : (
            <CollaborationAction
              path={`${path}/release`}
              label={t("Retirar vinculación", "Retirar vinculación")}
              danger
              body={(d) => ({
                expectedAgreementId: r.agreementId,
                expectedVersion: r.version,
                reason: textField(d, "reason").trim(),
              })}
            >
              <p>
                {t(
                  "El sistema comprueba nuevamente la vinculación antes de retirarla. Las reservas confirmadas se mantienen.",
                  "O sistema comproba novamente a vinculación antes de retirala. As reservas confirmadas mantéñense.",
                )}
              </p>
              <Reason />
              <Checkbox
                required
                label={t(
                  "Confirmo la retirada de esta vinculación",
                  "Confirmo a retirada desta vinculación",
                )}
              />
            </CollaborationAction>
          )}
        </>
      )}
    </ManagementPage>
  );
}
