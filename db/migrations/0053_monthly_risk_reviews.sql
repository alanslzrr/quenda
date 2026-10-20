CREATE TABLE domain.monthly_report_delivery (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 agreement_id uuid NOT NULL, month_start date NOT NULL, revision integer NOT NULL,
 recipient_tenant_id uuid NOT NULL, recipient_account_id text NOT NULL,
 delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(agreement_id,month_start,revision) REFERENCES domain.monthly_assessment(agreement_id,month_start,revision),
 FOREIGN KEY(recipient_tenant_id,recipient_account_id) REFERENCES domain.municipal_profile(tenant_id,account_id)
);
CREATE INDEX monthly_delivery_recipient ON domain.monthly_report_delivery(recipient_account_id,agreement_id,month_start,revision);
CREATE TABLE domain.monthly_risk_review (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 agreement_id uuid NOT NULL, month_start date NOT NULL, revision integer NOT NULL,
 reviewer_tenant_id uuid NOT NULL, reviewer_account_id text NOT NULL,
 recipient_tenant_id uuid NOT NULL, recipient_account_id text NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 history_digest text NOT NULL CHECK(history_digest ~ '^[0-9a-f]{64}$'),
 control_version integer NOT NULL,
 decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
 auxiliary_reference text NOT NULL CHECK(length(btrim(auxiliary_reference)) BETWEEN 1 AND 500),
 own_data_reference text NOT NULL CHECK(length(btrim(own_data_reference)) BETWEEN 1 AND 500),
 prior_releases_reference text NOT NULL CHECK(length(btrim(prior_releases_reference)) BETWEEN 1 AND 500),
 correction_reference text CHECK(correction_reference IS NULL OR length(btrim(correction_reference)) BETWEEN 1 AND 500),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(), correlation_id uuid NOT NULL,
 FOREIGN KEY(agreement_id,month_start,revision) REFERENCES domain.monthly_assessment(agreement_id,month_start,revision),
 FOREIGN KEY(reviewer_tenant_id,reviewer_account_id) REFERENCES domain.municipal_profile(tenant_id,account_id),
 FOREIGN KEY(recipient_tenant_id,recipient_account_id) REFERENCES domain.municipal_profile(tenant_id,account_id),
 CHECK(revision=1 OR correction_reference IS NOT NULL)
);
CREATE INDEX monthly_review_latest ON domain.monthly_risk_review(agreement_id,month_start,revision,recipient_tenant_id,recipient_account_id,reviewer_tenant_id,id DESC);
ALTER TABLE domain.monthly_report_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.monthly_report_delivery FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.monthly_risk_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.monthly_risk_review FORCE ROW LEVEL SECURITY;
CREATE POLICY monthly_delivery_maintenance ON domain.monthly_report_delivery TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY monthly_review_maintenance ON domain.monthly_risk_review TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.monthly_report_delivery,domain.monthly_risk_review FROM PUBLIC,quenda_domain,quenda_worker,quenda_auth;
CREATE TRIGGER monthly_delivery_immutable BEFORE UPDATE OR DELETE ON domain.monthly_report_delivery FOR EACH ROW EXECUTE FUNCTION domain.monthly_assessment_immutable();
CREATE TRIGGER monthly_review_immutable BEFORE UPDATE OR DELETE ON domain.monthly_risk_review FOR EACH ROW EXECUTE FUNCTION domain.monthly_assessment_immutable();

CREATE FUNCTION domain.monthly_release_history(recipient text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(d.agreement_id,d.month_start,d.revision) ORDER BY d.agreement_id,d.month_start,d.revision),'[]'::jsonb)::text,'UTF8')),'hex')
 FROM (SELECT DISTINCT agreement_id,month_start,revision FROM domain.monthly_report_delivery WHERE recipient_account_id=$1) d;
$$;
REVOKE ALL ON FUNCTION domain.monthly_release_history(text) FROM PUBLIC;

CREATE FUNCTION domain.monthly_review_context(agreement uuid,month_date date,assessment_revision integer,recipient_tenant uuid,recipient text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid; snapshot domain.monthly_assessment;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('quenda.report.recipient:'||recipient,0));
 PERFORM 1 FROM domain.agreement a WHERE a.id=$1 FOR SHARE;
 SELECT * INTO snapshot FROM domain.monthly_assessment s WHERE s.agreement_id=agreement AND s.month_start=month_date AND s.revision=assessment_revision;
 IF NOT FOUND OR NOT tenant=ANY(snapshot.participants) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF NOT recipient_tenant=ANY(snapshot.participants) OR NOT EXISTS(SELECT 1 FROM domain.municipal_profile p WHERE p.tenant_id=recipient_tenant AND p.account_id=recipient) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM domain.monthly_assessment s WHERE s.agreement_id=agreement AND s.month_start=month_date AND s.revision>assessment_revision) THEN RAISE EXCEPTION 'Stale assessment' USING ERRCODE='P0001'; END IF;
 RETURN domain.monthly_release_history(recipient);
END $$;
REVOKE ALL ON FUNCTION domain.monthly_review_context(uuid,date,integer,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.monthly_review_context(uuid,date,integer,uuid,text) TO quenda_domain;

CREATE FUNCTION domain.record_monthly_risk_review(agreement uuid,month_date date,assessment_revision integer,recipient_tenant uuid,recipient text,expected_history text,evidence jsonb,correlation uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE history text; snapshot domain.monthly_assessment; result bigint;
BEGIN
 history:=domain.monthly_review_context(agreement,month_date,assessment_revision,recipient_tenant,recipient);
 IF expected_history IS DISTINCT FROM history THEN RAISE EXCEPTION 'Release history changed' USING ERRCODE='P0001'; END IF;
 SELECT * INTO STRICT snapshot FROM domain.monthly_assessment s WHERE s.agreement_id=agreement AND s.month_start=month_date AND s.revision=assessment_revision;
 IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR NOT evidence ?& ARRAY['decision','auxiliaryReference','ownDataReference','priorReleasesReference','correctionReference']
 OR evidence-ARRAY['decision','auxiliaryReference','ownDataReference','priorReleasesReference','correctionReference']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='23514'; END IF;
 IF evidence->>'decision'='APPROVE' AND snapshot.status<>'THRESHOLD_MET' THEN RAISE EXCEPTION 'Suppressed assessment' USING ERRCODE='23514'; END IF;
 INSERT INTO domain.monthly_risk_review(agreement_id,month_start,revision,reviewer_tenant_id,reviewer_account_id,recipient_tenant_id,recipient_account_id,source_digest,history_digest,control_version,decision,auxiliary_reference,own_data_reference,prior_releases_reference,correction_reference,correlation_id)
 VALUES(agreement,month_date,assessment_revision,nullif(current_setting('quenda.tenant_id',true),'')::uuid,current_setting('quenda.account_id',true),recipient_tenant,recipient,snapshot.source_digest,history,snapshot.control_version,evidence->>'decision',btrim(evidence->>'auxiliaryReference'),btrim(evidence->>'ownDataReference'),btrim(evidence->>'priorReleasesReference'),btrim(evidence->>'correctionReference'),correlation) RETURNING id INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION domain.record_monthly_risk_review(uuid,date,integer,uuid,text,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.record_monthly_risk_review(uuid,date,integer,uuid,text,text,jsonb,uuid) TO quenda_domain;
