-- Schedule recommendations for the holder: computed on request from the
-- account's own confirmed reservations, shown only to that account and never
-- stored. The only new datum is the account's choice to turn them off.
ALTER TABLE domain.account_preferences ADD COLUMN recommendations boolean NOT NULL DEFAULT true;
GRANT UPDATE(recommendations) ON domain.account_preferences TO quenda_domain;

-- Repeated bookings of the same unit, weekday, local start and duration since
-- a given instant. Two occurrences make a habit; units no longer published or
-- withdrawn are left out. Only the calling account's reservations are read.
CREATE FUNCTION domain.own_booking_habits(since timestamptz)
RETURNS TABLE(tenant_id uuid,unit_id uuid,municipality text,weekday integer,start_minute integer,
 duration_minutes integer,occurrences integer,last_start timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.unit_id,m.name,h.weekday,h.start_minute,h.duration,count(*)::int,max(r.starts_at)
 FROM domain.reservation r
 JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 CROSS JOIN LATERAL (SELECT r.starts_at AT TIME ZONE r.timezone AS wall) w
 CROSS JOIN LATERAL (SELECT extract(isodow FROM w.wall)::int AS weekday,
  (extract(hour FROM w.wall)*60+extract(minute FROM w.wall))::int AS start_minute,
  (extract(epoch FROM r.ends_at-r.starts_at)/60)::int AS duration) h
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND since IS NOT NULL AND r.starts_at>=since AND r.status='CONFIRMADA'
 AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 GROUP BY r.tenant_id,r.unit_id,m.name,h.weekday,h.start_minute,h.duration
 HAVING count(*)>=2
 ORDER BY count(*) DESC,max(r.starts_at) DESC,r.tenant_id,r.unit_id,h.weekday,h.start_minute LIMIT 5
$$;
REVOKE ALL ON FUNCTION domain.own_booking_habits(timestamptz) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_booking_habits(timestamptz) TO quenda_domain;

-- The holder's personal data download includes the recommendation choice.
CREATE OR REPLACE FUNCTION domain.personal_data_records(subject text,scope_tenant uuid,include_global boolean,include_municipal boolean)
RETURNS TABLE(category text,tenant_id uuid,record_type text,record jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT 'IDENTITY'::text,NULL::uuid,'account'::text,jsonb_build_object(
 'accountId',u.id,'name',CASE WHEN to_jsonb(l)->>'erased_at' IS NULL THEN u.name END,'email',CASE WHEN to_jsonb(l)->>'erased_at' IS NULL THEN u.email END,'emailVerified',u."emailVerified",'image',CASE WHEN to_jsonb(l)->>'erased_at' IS NULL THEN u.image END,'erasedAt',to_jsonb(l)->'erased_at',
 'createdAt',u."createdAt",'updatedAt',u."updatedAt",'mfaEnabled',coalesce(u."twoFactorEnabled",false),
 'deactivatedAt',l.deactivated_at,'suspendedAt',l.suspended_at,'locale',p.locale,'theme',p.theme,'recommendations',coalesce(p.recommendations,true))
 FROM auth."user" u JOIN auth.account_lifecycle l ON l.account_id=u.id
 LEFT JOIN domain.account_preferences p ON p.account_id=u.id
 WHERE u.id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'calendarSubscription',jsonb_build_object('createdAt',c.created_at)
 FROM domain.calendar_subscription c WHERE c.account_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'session',jsonb_build_object('createdAt',s."createdAt",'expiresAt',s."expiresAt",'updatedAt',s."updatedAt",'ipAddress',s."ipAddress",'userAgent',s."userAgent",'mfaVerifiedAt',s."mfaVerifiedAt")
 FROM auth.session s WHERE s."userId"=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'credentialProvider',jsonb_build_object('provider',a."providerId",'createdAt',a."createdAt",'updatedAt',a."updatedAt")
 FROM auth.account a WHERE a."userId"=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'sessionEvent',jsonb_build_object('operation',e.operation,'occurredAt',e.occurred_at)
 FROM auth.session_event e WHERE e.subject_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'credentialEvent',jsonb_build_object('operation',e.operation,'occurredAt',e.occurred_at)
 FROM auth.credential_event e WHERE e.subject_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'authenticationRequest',jsonb_build_object('operation',e.operation,'phase',e.phase,'httpStatus',e.http_status,'occurredAt',e.occurred_at)
 FROM auth.request_event e WHERE e.actor_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'deactivation',jsonb_build_object('occurredAt',e.occurred_at,'revokedSessions',e.revoked_sessions)
 FROM auth.account_deactivation_event e WHERE e.subject_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'reactivation',jsonb_build_object('occurredAt',e.occurred_at,'previousDeactivatedAt',e.previous_deactivated_at)
 FROM auth.account_reactivation_event e WHERE e.subject_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'securityEvent',jsonb_build_object('operation',e.operation,'occurredAt',e.occurred_at,'revokedSessions',e.revoked_sessions)
 FROM auth.account_security_event e WHERE e.subject_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHENTICATION',NULL,'emailChange',jsonb_build_object('operation',e.operation,'source',e.source,'occurredAt',e.occurred_at,'revokedSessions',e.revoked_sessions)
 FROM auth.email_change_event e WHERE e.account_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHORITY',NULL,'accessDenial',jsonb_build_object('operation',e.operation,'outcome',e.outcome,'occurredAt',e.occurred_at,'requestedScopeRequiresReview',e.requested_tenant_id IS NOT NULL)
 FROM domain.access_denial e WHERE e.actor_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHORITY',NULL,'platformOperator',jsonb_build_object('grantedAt',p.created_at,'revokedAt',p.revoked_at)
 FROM domain.platform_operator p WHERE p.account_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHORITY',NULL,'operatorInvitation',jsonb_build_object('invitationId',i.id,'createdAt',i.created_at,'expiresAt',i.expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at)
 FROM domain.platform_operator_invitation i WHERE i.account_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHORITY',NULL,'globalPrivacyPermission',jsonb_build_object('invitationId',i.id,'permissions',i.permissions,'createdAt',i.created_at,'expiresAt',i.expires_at,'roleExpiresAt',i.role_expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at)
 FROM domain.global_privacy_invitation i WHERE i.account_id=subject AND include_global
 UNION ALL
 SELECT 'AUTHORITY',e.scope_tenant_id,'personalDataAccess',jsonb_build_object('mode',e.access_mode,'actorIsSubject',e.actor_id=subject,'occurredAt',e.occurred_at,'recordCount',e.record_count)
 FROM domain.personal_data_access_event e WHERE e.subject_id=subject AND ((include_global AND e.scope_tenant_id IS NULL) OR (include_municipal AND e.scope_tenant_id IS NOT NULL AND (scope_tenant IS NULL OR e.scope_tenant_id=scope_tenant)))
 UNION ALL
 SELECT 'MUNICIPAL_PROFILE',p.tenant_id,'municipalProfile',jsonb_build_object('municipality',m.name,'createdAt',p.created_at)
 FROM domain.municipal_profile p JOIN domain.municipality m ON m.id=p.tenant_id
 WHERE p.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR p.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'AUTHORITY',a.tenant_id,'municipalAdministrator',jsonb_build_object('grantedAt',a.granted_at,'expiresAt',a.expires_at,'revokedAt',a.revoked_at)
 FROM domain.municipal_administrator a WHERE a.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR a.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'AUTHORITY',i.tenant_id,'administratorInvitation',jsonb_build_object('invitationId',i.id,'createdAt',i.created_at,'expiresAt',i.expires_at,'roleExpiresAt',i.role_expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at)
 FROM domain.administrator_invitation i WHERE i.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR i.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'AUTHORITY',i.tenant_id,'managerInvitation',jsonb_build_object('invitationId',i.id,'createdAt',i.created_at,'expiresAt',i.expires_at,'roleExpiresAt',i.role_expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at,'grantRevokedAt',g.revoked_at,
 'permissions',coalesce((SELECT jsonb_agg(jsonb_build_object('operation',p.operation,'unitId',p.unit_id) ORDER BY p.operation,p.unit_id) FROM domain.manager_permission p WHERE (p.tenant_id,p.invitation_id)=(i.tenant_id,i.id)),'[]'::jsonb))
 FROM domain.manager_invitation i LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id)
 WHERE i.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR i.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'RESERVATIONS',r.tenant_id,'reservation',jsonb_build_object('reservationId',r.id,'unitId',r.unit_id,'unitName',u.name,'facilityId',f.id,'facilityName',f.name,
 'createdAt',r.created_at,'conditions',domain.personal_reservation_snapshot(domain.reservation_snapshot(r)),
 'acceptedUsageRulesText',v.text_content,'pendingUsageRulesText',pending.text_content,'arrivedAt',r.arrived_at)
 FROM domain.reservation r JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 LEFT JOIN domain.unit_usage_rules v ON (v.tenant_id,v.unit_id,v.version)=(r.tenant_id,r.usage_rules_unit_id,r.usage_rules_version)
 LEFT JOIN domain.unit_usage_rules pending ON (pending.tenant_id,pending.unit_id,pending.version)=(r.tenant_id,r.unit_id,r.pending_usage_rules_version)
 WHERE r.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR r.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'RESERVATIONS',e.tenant_id,'reservationEvent',jsonb_build_object('eventId',e.id,'reservationId',e.reservation_id,'revision',e.revision,'kind',e.kind,
 'actorIsSubject',e.actor_id=subject,'administrative',e.administrative,'occurredAt',e.occurred_at,
 'before',CASE WHEN e.before_state IS NULL THEN NULL ELSE domain.personal_reservation_snapshot(e.before_state) END,'after',domain.personal_reservation_snapshot(e.after_state),
 'reasonRequiresReview',e.reason IS NOT NULL)
 FROM domain.reservation_event e JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id)
 WHERE r.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR e.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'COMMUNICATIONS',n.tenant_id,'reservationNotice',jsonb_build_object('eventId',n.event_id,'createdAt',n.created_at,'emailAttempts',q.attempts,
 'emailAcceptedAt',q.accepted_at,'emailExhaustedAt',q.exhausted_at,'locale',q.locale)
 FROM domain.reservation_notice n LEFT JOIN domain.reservation_email q ON (q.tenant_id,q.event_id)=(n.tenant_id,n.event_id)
 WHERE n.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR n.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'COMMUNICATIONS',a.tenant_id,'emailAttempt',jsonb_build_object('eventId',a.event_id,'attempt',a.attempt,'startedAt',a.started_at,'finishedAt',a.finished_at,'outcome',a.outcome)
 FROM domain.reservation_email_attempt a JOIN domain.reservation_notice n ON (n.tenant_id,n.event_id)=(a.tenant_id,a.event_id)
 WHERE n.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR a.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'ACCREDITATIONS',c.issuer_tenant_id,'agreementCredential',jsonb_build_object('credentialId',c.id,'agreementId',c.agreement_id,'issuedVersion',c.issued_version,
 'startsAt',c.starts_at,'endsAt',c.ends_at,'issuedAt',c.issued_at,'revokedAt',c.revoked_at,'verificationReferenceRequiresReview',true,'revocationReasonRequiresReview',c.revocation_reason IS NOT NULL)
 FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
 WHERE s.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR c.issuer_tenant_id=scope_tenant)
 UNION ALL
 SELECT 'RESERVATIONS',c.tenant_id,'agreementConsumption',jsonb_build_object('agreementId',c.agreement_id,'reservationId',c.reservation_id,'attributionVersion',c.attribution_version,
 'unitId',c.unit_id,'startsAt',c.starts_at,'endsAt',c.ends_at,'weekStart',c.week_start,'released',c.released)
 FROM domain.agreement_consumption c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
 WHERE s.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR c.tenant_id=scope_tenant)
 UNION ALL
 SELECT 'RESERVATIONS',e.tenant_id,'agreementConsumptionEvent',jsonb_build_object('agreementId',e.agreement_id,'reservationId',e.reservation_id,'version',e.version,
 'action',e.action,'weekStart',e.week_start,'startsAt',e.starts_at,'endsAt',e.ends_at,'occurredAt',e.occurred_at)
 FROM domain.agreement_consumption_event e JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(e.agreement_id,e.subject_id)
 WHERE s.account_id=subject AND include_municipal AND (scope_tenant IS NULL OR e.tenant_id=scope_tenant)
$$;
