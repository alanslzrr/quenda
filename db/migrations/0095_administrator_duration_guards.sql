-- A temporary administrator cannot outlive its own grant: it neither converts
-- grants to indefinite nor issues administrator roles that end after its own.
CREATE FUNCTION domain.administrator_role_within_issuer(role_expiry timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.municipal_administrator a
  WHERE a.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
   AND a.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND a.revoked_at IS NULL
   AND (a.expires_at IS NULL OR (role_expiry IS NOT NULL AND role_expiry<=a.expires_at)))
$$;
REVOKE ALL ON FUNCTION domain.administrator_role_within_issuer(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.administrator_role_within_issuer(timestamptz) TO quenda_domain;

ALTER POLICY invitation_create ON domain.administrator_invitation
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND invited_by=nullif(current_setting('quenda.account_id',true),'')
  AND accepted_at IS NULL AND revoked_at IS NULL
  AND ((grant_source='PLATFORM' AND domain.lock_current_operator() AND domain.municipality_bootstrap_open())
   OR (grant_source='MUNICIPAL' AND domain.lock_current_administrator()
    AND domain.administrator_role_within_issuer(role_expires_at))));

CREATE OR REPLACE FUNCTION domain.make_administrator_indefinite(subject text,rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE source uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF subject=actor OR NOT domain.administrator_role_within_issuer(NULL) THEN
  RAISE EXCEPTION 'Indefinite administrator required' USING ERRCODE='42501';
 END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=subject AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE domain.municipal_administrator SET expires_at=NULL
  WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL AND expires_at>now() RETURNING invitation_id INTO source;
 IF NOT FOUND THEN
  RETURN EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL AND expires_at IS NULL);
 END IF;
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  VALUES(tenant,gen_random_uuid(),actor,'MAKE_ADMINISTRATOR_INDEFINITE',subject,source,rationale);
 RETURN true;
END $$;
