-- Reservations of the calling account with what a calendar entry needs: names and the facility's location.
-- Only the account's own rows are visible, whatever the tenant context.
CREATE FUNCTION domain.own_calendar_reservations(max_rows integer)
RETURNS TABLE(tenant_id uuid,id uuid,status text,starts_at timestamptz,ends_at timestamptz,revision integer,
 municipality text,unit_name text,facility_name text,address text,postal_code text,latitude numeric,longitude numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.status,r.starts_at,r.ends_at,r.revision,m.name,u.name,f.name,f.address,f.postal_code,f.latitude,f.longitude
 FROM domain.reservation r
 JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND r.status='CONFIRMADA' AND r.ends_at>now()
 ORDER BY r.starts_at,r.id,r.tenant_id LIMIT least(greatest(max_rows,1),500)
$$;
CREATE FUNCTION domain.own_calendar_reservation(selected_tenant uuid,selected uuid)
RETURNS TABLE(tenant_id uuid,id uuid,status text,starts_at timestamptz,ends_at timestamptz,revision integer,
 municipality text,unit_name text,facility_name text,address text,postal_code text,latitude numeric,longitude numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.status,r.starts_at,r.ends_at,r.revision,m.name,u.name,f.name,f.address,f.postal_code,f.latitude,f.longitude
 FROM domain.reservation r
 JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE r.tenant_id=selected_tenant AND r.id=selected
 AND r.account_id=nullif(current_setting('quenda.account_id',true),'')
$$;
REVOKE ALL ON FUNCTION domain.own_calendar_reservations(integer),domain.own_calendar_reservation(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_calendar_reservations(integer),domain.own_calendar_reservation(uuid,uuid) TO quenda_domain;
