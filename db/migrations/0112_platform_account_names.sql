-- Presentation only: names, never e-mail, of accounts already known in the
-- platform scope (operators and the subjects or issuers of operator and global
-- privacy invitations). No global directory and no direct grants on the
-- authentication tables. Erased or unnamed accounts return no row.
CREATE FUNCTION domain.platform_account_names(accounts text[])
RETURNS TABLE(account_id text, name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 IF accounts IS NULL OR cardinality(accounts)>100 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT u.id,btrim(u.name) FROM auth."user" u
 WHERE u.id=ANY(accounts) AND u.email NOT LIKE '%@erased.invalid' AND btrim(coalesce(u.name,''))<>''
 AND (
  EXISTS(SELECT 1 FROM domain.platform_operator p WHERE p.account_id=u.id)
  OR EXISTS(SELECT 1 FROM domain.platform_operator_invitation i WHERE i.account_id=u.id OR i.invited_by=u.id)
  OR EXISTS(SELECT 1 FROM domain.global_privacy_invitation i WHERE i.account_id=u.id OR i.invited_by=u.id)
 );
END $$;
REVOKE ALL ON FUNCTION domain.platform_account_names(text[]) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.platform_account_names(text[]) TO quenda_domain;
