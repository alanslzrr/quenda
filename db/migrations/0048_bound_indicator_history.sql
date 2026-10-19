-- Keep the last pre-period state, not the complete lifetime of the resource.
CREATE INDEX calendar_indicator_history ON domain.unit_calendar_version(tenant_id,unit_id,created_at DESC,version DESC);
CREATE INDEX publication_indicator_history ON domain.catalog_event(tenant_id,facility_id,unit_id,occurred_at DESC)
 WHERE operation IN ('PUBLISH_UNIT','WITHDRAW_UNIT','PUBLISH_FACILITY','WITHDRAW_FACILITY');
CREATE OR REPLACE FUNCTION domain.unit_indicator_source(unit uuid,from_date date,to_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 previous_calendar integer; unit_transition timestamptz; facility_transition timestamptz;
 parent uuid; zone text; first_instant timestamptz; last_instant timestamptz; result jsonb;
BEGIN
 IF NOT domain.lock_permission('REPORT_READ',unit) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF from_date IS NULL OR to_date IS NULL OR NOT isfinite(from_date) OR NOT isfinite(to_date) OR to_date-from_date NOT BETWEEN 1 AND 366 THEN
  RAISE EXCEPTION 'Invalid period' USING ERRCODE='23514';
 END IF;
 SELECT u.facility_id,m.timezone INTO parent,zone FROM domain.reservable_unit u JOIN domain.municipality m ON m.id=u.tenant_id WHERE u.tenant_id=tenant AND u.id=unit;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 first_instant:=from_date::timestamp AT TIME ZONE zone;
 last_instant:=to_date::timestamp AT TIME ZONE zone;
 SELECT v.version INTO previous_calendar FROM domain.unit_calendar_version v WHERE v.tenant_id=tenant AND v.unit_id=unit AND v.created_at<first_instant ORDER BY v.created_at DESC,v.version DESC LIMIT 1;
 SELECT max(e.occurred_at) INTO unit_transition FROM domain.catalog_event e WHERE e.tenant_id=tenant AND e.facility_id=parent AND e.unit_id=unit AND e.occurred_at<first_instant AND e.operation IN ('PUBLISH_UNIT','WITHDRAW_UNIT');
 SELECT max(e.occurred_at) INTO facility_transition FROM domain.catalog_event e WHERE e.tenant_id=tenant AND e.facility_id=parent AND e.unit_id IS NULL AND e.occurred_at<first_instant AND e.operation IN ('PUBLISH_FACILITY','WITHDRAW_FACILITY');
 IF (SELECT count(*) FROM domain.unit_calendar_version v WHERE v.tenant_id=tenant AND v.unit_id=unit AND v.created_at<last_instant AND (v.created_at>=first_instant OR v.version=previous_calendar))>1000
 OR (SELECT count(*) FROM domain.catalog_event e WHERE e.tenant_id=tenant AND e.facility_id=parent AND (e.unit_id=unit OR e.unit_id IS NULL) AND e.occurred_at<last_instant AND (e.occurred_at>=first_instant OR (e.unit_id=unit AND e.occurred_at=unit_transition) OR (e.unit_id IS NULL AND e.occurred_at=facility_transition)) AND e.operation IN ('PUBLISH_UNIT','WITHDRAW_UNIT','PUBLISH_FACILITY','WITHDRAW_FACILITY'))>2000
 OR (SELECT count(*) FROM domain.reservation r WHERE r.tenant_id=tenant AND r.unit_id=unit AND r.starts_at<last_instant AND r.ends_at>first_instant)>10000
 OR (SELECT count(*) FROM domain.schedule_block b WHERE b.tenant_id=tenant AND b.unit_id=unit AND b.starts_at<last_instant AND b.ends_at>first_instant)>10000 THEN
  RAISE EXCEPTION 'Report period too large' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_build_object('timeZone',zone,'asOf',statement_timestamp(),
  'calendars',coalesce((SELECT jsonb_agg(jsonb_build_object('version',v.version,'createdAt',v.created_at,
   'calendar',jsonb_build_object('minimumMinutes',v.minimum_minutes,'maximumMinutes',v.maximum_minutes,'stepMinutes',v.step_minutes,'advanceDays',v.advance_days,'weekly',v.weekly,'exceptions',v.exceptions)) ORDER BY v.created_at,v.version)
   FROM domain.unit_calendar_version v WHERE v.tenant_id=tenant AND v.unit_id=unit AND v.created_at<last_instant AND (v.created_at>=first_instant OR v.version=previous_calendar)),'[]'::jsonb),
  'publications',coalesce((SELECT jsonb_agg(jsonb_build_object('operation',e.operation,'occurredAt',e.occurred_at) ORDER BY e.occurred_at,e.id)
   FROM domain.catalog_event e WHERE e.tenant_id=tenant AND e.facility_id=parent AND (e.unit_id=unit OR e.unit_id IS NULL)
   AND e.occurred_at<last_instant AND (e.occurred_at>=first_instant OR (e.unit_id=unit AND e.occurred_at=unit_transition) OR (e.unit_id IS NULL AND e.occurred_at=facility_transition)) AND e.operation IN ('PUBLISH_UNIT','WITHDRAW_UNIT','PUBLISH_FACILITY','WITHDRAW_FACILITY')),'[]'::jsonb),
  'closures',coalesce((SELECT jsonb_agg(jsonb_build_object('start',greatest(b.starts_at,b.created_at),'end',least(b.ends_at,coalesce(b.released_at,b.ends_at))))
   FROM domain.schedule_block b WHERE b.tenant_id=tenant AND b.unit_id=unit AND b.starts_at<last_instant AND b.ends_at>first_instant
   AND greatest(b.starts_at,b.created_at)<least(b.ends_at,coalesce(b.released_at,b.ends_at))),'[]'::jsonb),
  'reservations',coalesce((SELECT jsonb_agg(jsonb_build_object('unitId',r.unit_id,'start',r.starts_at,'end',r.ends_at,'status',r.status))
   FROM domain.reservation r WHERE r.tenant_id=tenant AND r.unit_id=unit AND r.starts_at<last_instant AND r.ends_at>first_instant),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION domain.unit_indicator_source(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.unit_indicator_source(uuid,date,date) TO quenda_domain;
