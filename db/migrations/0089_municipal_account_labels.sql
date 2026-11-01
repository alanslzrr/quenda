-- Presentation only: bounded lookup of accounts already known in this municipal
-- scope. No global directory and no direct grants on the authentication tables.
CREATE FUNCTION domain.municipal_account_labels(accounts text[])
RETURNS TABLE(account_id text, name text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF accounts IS NULL OR cardinality(accounts)>100 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT u.id,u.name,u.email FROM auth."user" u
 WHERE u.id=ANY(accounts) AND u.email NOT LIKE '%@erased.invalid'
 AND (
  EXISTS(SELECT 1 FROM domain.municipal_profile p WHERE p.tenant_id=tenant AND p.account_id=u.id)
  OR EXISTS(SELECT 1 FROM domain.administrator_invitation i WHERE i.tenant_id=tenant AND (i.account_id=u.id OR i.invited_by=u.id))
  OR EXISTS(SELECT 1 FROM domain.manager_invitation i WHERE i.tenant_id=tenant AND (i.account_id=u.id OR i.invited_by=u.id))
 );
END $$;
REVOKE ALL ON FUNCTION domain.municipal_account_labels(text[]) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.municipal_account_labels(text[]) TO quenda_domain;
