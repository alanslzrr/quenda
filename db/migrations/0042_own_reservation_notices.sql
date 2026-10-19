CREATE FUNCTION domain.own_reservation_notices(after_event uuid,after_tenant uuid)
RETURNS TABLE(event_id uuid,tenant_id uuid,reservation_id uuid,revision integer,kind text,occurred_at timestamptz,unit_id uuid,starts_at timestamptz,ends_at timestamptz,timezone text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT n.event_id,n.tenant_id,e.reservation_id,e.revision,e.kind,e.occurred_at,
  (e.after_state->>'unitId')::uuid,(e.after_state->>'startsAt')::timestamptz,
  (e.after_state->>'endsAt')::timestamptz,e.after_state->>'timezone'
 FROM domain.reservation_notice n
 JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(n.tenant_id,n.event_id)
 WHERE n.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND ($1 IS NULL OR (n.event_id,n.tenant_id)>($1,$2))
 ORDER BY n.event_id,n.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservation_notices(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_reservation_notices(uuid,uuid) TO quenda_domain;
CREATE INDEX reservation_notice_owner_page ON domain.reservation_notice(account_id,event_id,tenant_id);
