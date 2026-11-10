-- A conflict is examined again after as long as it has already lasted, between
-- one hour and seven days. Standing conflicts therefore stop consuming the
-- fixed batch budget every hour ahead of records that can be erased.
CREATE OR REPLACE FUNCTION domain.retention_candidate_due(scope_tenant uuid,scope_category text,target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM domain.retention_conflict c JOIN domain.retention_policy p ON p.id=c.policy_id
 WHERE p.tenant_id IS NOT DISTINCT FROM scope_tenant AND p.category=scope_category AND p.revoked_at IS NULL AND p.superseded_at IS NULL
 AND c.target_key=target
 AND c.last_seen_at>statement_timestamp()-greatest(interval '1 hour',least(c.last_seen_at-c.first_seen_at,interval '7 days')))
$$;
