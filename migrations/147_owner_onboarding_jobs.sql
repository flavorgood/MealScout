-- MealScout migration 147, reserved by the owning onboarding lane on 2026-10-05.
-- New onboarding research only; no edits to unrelated queues or payment tables.
CREATE TABLE IF NOT EXISTS owner_onboarding_jobs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id varchar NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  input jsonb NOT NULL,
  status varchar NOT NULL DEFAULT 'queued',
  revision integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token varchar(64),
  lease_expires_at timestamptz,
  research_receipt jsonb,
  preview_draft_id varchar REFERENCES owner_ai_action_drafts(id) ON DELETE SET NULL,
  preview_draft_revision integer,
  last_error_code varchar(64),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_onboarding_jobs_status_check CHECK (status IN ('queued','running','retry_wait','completed','failed')),
  CONSTRAINT owner_onboarding_jobs_attempts_check CHECK (max_attempts = 3 AND attempts BETWEEN 0 AND max_attempts AND revision > 0),
  CONSTRAINT owner_onboarding_jobs_lease_check CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CONSTRAINT owner_onboarding_jobs_result_check CHECK (
    (status = 'completed' AND research_receipt IS NOT NULL AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND research_receipt IS NULL AND completed_at IS NULL)),
  CONSTRAINT owner_onboarding_jobs_input_check CHECK (jsonb_typeof(input) = 'object' AND octet_length(input::text) <= 16384),
  CONSTRAINT owner_onboarding_jobs_receipt_check CHECK (research_receipt IS NULL OR (jsonb_typeof(research_receipt) = 'object' AND octet_length(research_receipt::text) <= 65536)),
  CONSTRAINT owner_onboarding_jobs_identity_check CHECK (request_hash ~ '^[a-f0-9]{64}$' AND idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT owner_onboarding_jobs_preview_check CHECK (
    (preview_draft_revision IS NULL OR preview_draft_revision > 0) AND
    (preview_draft_id IS NULL OR (preview_draft_revision IS NOT NULL AND status = 'completed')))
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_onboarding_jobs_owner_business_idx ON owner_onboarding_jobs(owner_id, restaurant_id);
CREATE UNIQUE INDEX IF NOT EXISTS owner_onboarding_jobs_idempotency_idx ON owner_onboarding_jobs(owner_id, restaurant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS owner_onboarding_jobs_recovery_idx ON owner_onboarding_jobs(status, available_at, lease_expires_at);
