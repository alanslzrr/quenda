-- Municipal analytics settings: the occupancy thresholds that label spaces as
-- in high demand or little used, and the period the analysis opens with. They
-- apply to every reader of the municipality; personal display choices stay in
-- the browser.
ALTER TABLE domain.municipality
 ADD COLUMN analytics_version integer NOT NULL DEFAULT 1 CHECK(analytics_version>0),
 ADD COLUMN analytics_high_demand_percent smallint NOT NULL DEFAULT 85 CHECK(analytics_high_demand_percent BETWEEN 1 AND 99),
 ADD COLUMN analytics_low_use_percent smallint NOT NULL DEFAULT 20 CHECK(analytics_low_use_percent BETWEEN 1 AND 99),
 ADD COLUMN analytics_default_period text NOT NULL DEFAULT 'THIS_MONTH'
  CHECK(analytics_default_period IN ('THIS_WEEK','THIS_MONTH','LAST_MONTH','LAST_30_DAYS')),
 ADD CONSTRAINT municipality_analytics_thresholds CHECK(analytics_low_use_percent<analytics_high_demand_percent);
CREATE TABLE domain.municipal_analytics_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 version integer NOT NULL,
 previous_state jsonb NOT NULL,
 next_state jsonb NOT NULL,
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,version)
);
ALTER TABLE domain.municipal_analytics_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_analytics_event FORCE ROW LEVEL SECURITY;
CREATE POLICY analytics_event_maintenance ON domain.municipal_analytics_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.municipal_analytics_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

-- Readable by the administrator and by anyone who may analyse the municipality
-- or at least one of its units.
CREATE FUNCTION domain.municipal_analytics_settings()
RETURNS TABLE(version integer,high_demand_percent smallint,low_use_percent smallint,default_period text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF tenant IS NULL OR NOT domain.account_enabled(nullif(current_setting('quenda.account_id',true),''))
  OR NOT (domain.lock_permission('REPORT_READ',NULL) OR EXISTS(SELECT 1 FROM domain.reservable_unit u
   WHERE u.tenant_id=tenant AND domain.lock_permission('REPORT_READ',u.id)))
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.analytics_version,m.analytics_high_demand_percent,m.analytics_low_use_percent,m.analytics_default_period
  FROM domain.municipality m WHERE m.id=tenant;
END $$;

CREATE FUNCTION domain.save_municipal_analytics_settings(expected integer,high_value smallint,low_value smallint,period_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous domain.municipality%ROWTYPE;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_current_administrator()
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected NOT BETWEEN 1 AND 2147483646 OR correlation IS NULL
 OR high_value IS NULL OR high_value NOT BETWEEN 1 AND 99 OR low_value IS NULL OR low_value NOT BETWEEN 1 AND 99
 OR low_value>=high_value
 OR period_value IS NULL OR period_value NOT IN ('THIS_WEEK','THIS_MONTH','LAST_MONTH','LAST_30_DAYS')
 THEN RAISE EXCEPTION 'Invalid analytics settings' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR previous.analytics_version<>expected THEN RETURN NULL; END IF;
 UPDATE domain.municipality SET analytics_version=expected+1,analytics_high_demand_percent=high_value,
  analytics_low_use_percent=low_value,analytics_default_period=period_value WHERE id=tenant;
 INSERT INTO domain.municipal_analytics_event(tenant_id,actor_id,version,previous_state,next_state,correlation_id)
 VALUES(tenant,actor,expected+1,
  jsonb_build_object('highDemandPercent',previous.analytics_high_demand_percent,'lowUsePercent',previous.analytics_low_use_percent,
   'defaultPeriod',previous.analytics_default_period),
  jsonb_build_object('highDemandPercent',high_value,'lowUsePercent',low_value,'defaultPeriod',period_value),correlation);
 RETURN expected+1;
END $$;
REVOKE ALL ON FUNCTION domain.municipal_analytics_settings(),domain.save_municipal_analytics_settings(integer,smallint,smallint,text,uuid)
 FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.municipal_analytics_settings(),domain.save_municipal_analytics_settings(integer,smallint,smallint,text,uuid)
 TO quenda_domain;
