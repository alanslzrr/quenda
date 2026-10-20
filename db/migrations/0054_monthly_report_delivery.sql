ALTER TABLE domain.monthly_report_delivery ADD COLUMN authorization_history_digest text CHECK(authorization_history_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE domain.monthly_report_delivery ADD COLUMN review_ids bigint[];
CREATE FUNCTION domain.deliver_monthly_report(agreement uuid,month_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid; recipient text:=nullif(current_setting('quenda.account_id',true),'');
 snapshot domain.monthly_assessment; history text; review domain.monthly_risk_review; ids bigint[]:='{}'; valid_history boolean:=true;
BEGIN
 IF NOT domain.lock_permission('REPORT_READ',NULL) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF month_date IS NULL OR NOT isfinite(month_date) OR extract(day FROM month_date)<>1 THEN RAISE EXCEPTION 'Invalid month' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('quenda.report.recipient:'||recipient,0));
 PERFORM 1 FROM domain.agreement a WHERE a.id=$1 FOR SHARE;
 SELECT * INTO snapshot FROM domain.monthly_assessment s WHERE s.agreement_id=agreement AND s.month_start=month_date ORDER BY s.revision DESC LIMIT 1;
 IF NOT FOUND OR snapshot.status<>'THRESHOLD_MET' OR snapshot.control_version<>1 OR NOT tenant=ANY(snapshot.participants)
 OR NOT EXISTS(SELECT 1 FROM domain.agreement_activation a JOIN domain.agreement_version v ON (v.agreement_id,v.version)=(a.agreement_id,a.version)
  JOIN domain.agreement_participant p ON (p.agreement_id,p.version)=(v.agreement_id,v.version)
  WHERE a.agreement_id=agreement AND a.effective_period @> statement_timestamp() AND v.aggregate_reports AND p.tenant_id=tenant)
 THEN RETURN jsonb_build_object('status','NOT_PUBLISHABLE'); END IF;
 history:=domain.monthly_release_history(recipient);
 FOR review IN SELECT DISTINCT ON (r.reviewer_tenant_id) r.* FROM domain.monthly_risk_review r
  WHERE r.agreement_id=agreement AND r.month_start=month_date AND r.revision=snapshot.revision
   AND r.recipient_tenant_id=tenant AND r.recipient_account_id=recipient AND r.reviewer_tenant_id=ANY(snapshot.participants)
  ORDER BY r.reviewer_tenant_id,r.id DESC LOOP
  IF review.decision<>'APPROVE' OR review.control_version<>snapshot.control_version OR review.source_digest<>snapshot.source_digest
   OR (snapshot.revision>1 AND review.correction_reference IS NULL) THEN RETURN jsonb_build_object('status','NOT_PUBLISHABLE'); END IF;
  ids:=array_append(ids,review.id);
  valid_history:=valid_history AND review.history_digest=history;
 END LOOP;
 IF cardinality(ids)<>cardinality(snapshot.participants) OR cardinality(ids)=0 THEN RETURN jsonb_build_object('status','NOT_PUBLISHABLE'); END IF;
 -- An identical, already authorized release adds no information. New reviews or
 -- another recipient cannot reuse that prior authorization.
 IF NOT valid_history AND NOT EXISTS(SELECT 1 FROM domain.monthly_report_delivery d WHERE d.agreement_id=agreement AND d.month_start=month_date AND d.revision=snapshot.revision
  AND d.recipient_tenant_id=tenant AND d.recipient_account_id=recipient AND d.review_ids=ids) THEN RETURN jsonb_build_object('status','NOT_PUBLISHABLE'); END IF;
 INSERT INTO domain.monthly_report_delivery(agreement_id,month_start,revision,recipient_tenant_id,recipient_account_id,authorization_history_digest,review_ids)
 VALUES(agreement,month_date,snapshot.revision,tenant,recipient,history,ids);
 RETURN jsonb_build_object('status','PUBLISHABLE','agreementId',agreement,'month',to_char(month_date,'YYYY-MM'),'revision',snapshot.revision,'cutoff',snapshot.cutoff,
  'controlVersion',snapshot.control_version,'reservations',snapshot.reservations,'reservedMinutes',snapshot.reserved_minutes);
END $$;
REVOKE ALL ON FUNCTION domain.deliver_monthly_report(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.deliver_monthly_report(uuid,date) TO quenda_domain;
