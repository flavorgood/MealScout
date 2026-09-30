-- Optional public-link permissions only. No profiles, sessions, payments or
-- contact details are copied; existing and future permissions start unapproved.
CREATE TABLE IF NOT EXISTS mealscout_public_link_authority (
  source_id VARCHAR PRIMARY KEY,
  generation_id VARCHAR(32) NOT NULL CHECK (generation_id ~ '^[a-f0-9]{32}$'),
  public_tenant_id VARCHAR(32) NOT NULL CHECK (public_tenant_id ~ '^[a-f0-9]{32}$'),
  owner_id VARCHAR,
  native_revision BIGINT NOT NULL DEFAULT 1 CHECK (native_revision > 0),
  authority_revision BIGINT NOT NULL DEFAULT 1 CHECK (authority_revision > 0),
  state TEXT NOT NULL DEFAULT 'unapproved'
    CHECK (state IN ('unapproved', 'approved', 'revoked', 'deleted')),
  approved_native_revision BIGINT,
  approved_content_digest VARCHAR(64),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CHECK (state <> 'approved' OR (
    owner_id IS NOT NULL AND approved_native_revision IS NOT NULL
    AND approved_native_revision = native_revision
    AND approved_content_digest IS NOT NULL
    AND approved_content_digest ~ '^[a-f0-9]{64}$'
    AND approved_at IS NOT NULL AND expires_at IS NOT NULL
    AND expires_at > approved_at
    AND expires_at <= approved_at + INTERVAL '30 days'))
);
CREATE INDEX IF NOT EXISTS mealscout_public_link_authority_owner_idx
  ON mealscout_public_link_authority(owner_id);
COMMENT ON TABLE mealscout_public_link_authority IS
  'MealScout-owned optional public link approval. Tombstones survive native deletion; owner identities are never in the exported DTO.';

CREATE TABLE IF NOT EXISTS mealscout_public_link_authority_events (
  event_id BIGSERIAL PRIMARY KEY,
  source_id VARCHAR NOT NULL,
  generation_id VARCHAR(32) NOT NULL,
  native_revision BIGINT NOT NULL,
  authority_revision BIGINT NOT NULL,
  state TEXT NOT NULL,
  approval_owner_id VARCHAR,
  content_digest VARCHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION mealscout_audit_public_link_authority()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mealscout_public_link_authority_events
    (source_id, generation_id, native_revision, authority_revision, state,
      approval_owner_id, content_digest)
  VALUES (NEW.source_id, NEW.generation_id, NEW.native_revision,
    NEW.authority_revision, NEW.state,
    CASE WHEN NEW.state = 'approved' THEN NEW.owner_id ELSE NULL END,
    NEW.approved_content_digest);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mealscout_public_link_authority_audit
  ON mealscout_public_link_authority;
CREATE TRIGGER mealscout_public_link_authority_audit AFTER INSERT OR UPDATE
  ON mealscout_public_link_authority FOR EACH ROW
  EXECUTE FUNCTION mealscout_audit_public_link_authority();

CREATE OR REPLACE FUNCTION mealscout_track_public_link_source()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mealscout_public_link_authority
      (source_id, generation_id, public_tenant_id, owner_id)
    VALUES (NEW.id, replace(gen_random_uuid()::text, '-', ''),
      replace(gen_random_uuid()::text, '-', ''), NEW.owner_id)
    ON CONFLICT (source_id) DO UPDATE SET
      generation_id = EXCLUDED.generation_id,
      public_tenant_id = EXCLUDED.public_tenant_id,
      owner_id = EXCLUDED.owner_id, native_revision = 1,
      authority_revision = mealscout_public_link_authority.authority_revision + 1,
      state = 'unapproved', approved_native_revision = NULL,
      approved_content_digest = NULL, approved_at = NULL, expires_at = NULL;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE mealscout_public_link_authority SET
      owner_id = NULL, native_revision = native_revision + 1,
      authority_revision = authority_revision + 1, state = 'deleted',
      approved_native_revision = NULL, approved_content_digest = NULL,
      approved_at = NULL, expires_at = NULL WHERE source_id = OLD.id;
    RETURN OLD;
  END IF;
  -- These fields decide restaurant identity/admission or optional quarantine.
  -- Private identity anchors can affect quarantine without being exported.
  -- Payment state, analytics and unrelated fields remain outside this scope.
  IF jsonb_build_array(NEW.owner_id, NEW.name, NEW.is_active,
    to_jsonb(NEW)->'business_type', to_jsonb(NEW)->'is_food_truck',
    to_jsonb(NEW)->'city', to_jsonb(NEW)->'state', to_jsonb(NEW)->'cuisine_type',
    to_jsonb(NEW)->'description', to_jsonb(NEW)->'raw_data',
    to_jsonb(NEW)->'phone', to_jsonb(NEW)->'email',
    to_jsonb(NEW)->'website_url', to_jsonb(NEW)->'address') IS DISTINCT FROM
    jsonb_build_array(OLD.owner_id, OLD.name, OLD.is_active,
    to_jsonb(OLD)->'business_type', to_jsonb(OLD)->'is_food_truck',
    to_jsonb(OLD)->'city', to_jsonb(OLD)->'state', to_jsonb(OLD)->'cuisine_type',
    to_jsonb(OLD)->'description', to_jsonb(OLD)->'raw_data',
    to_jsonb(OLD)->'phone', to_jsonb(OLD)->'email',
    to_jsonb(OLD)->'website_url', to_jsonb(OLD)->'address') THEN
    UPDATE mealscout_public_link_authority SET
      owner_id = NEW.owner_id, native_revision = native_revision + 1,
      generation_id = CASE WHEN NEW.owner_id IS DISTINCT FROM OLD.owner_id
        THEN replace(gen_random_uuid()::text, '-', '') ELSE generation_id END,
      public_tenant_id = CASE WHEN NEW.owner_id IS DISTINCT FROM OLD.owner_id
        THEN replace(gen_random_uuid()::text, '-', '') ELSE public_tenant_id END,
      authority_revision = authority_revision + 1, state = 'revoked',
      approved_native_revision = NULL, approved_content_digest = NULL,
      approved_at = NULL, expires_at = NULL WHERE source_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mealscout_public_link_source ON restaurants;
CREATE TRIGGER mealscout_public_link_source
  AFTER INSERT OR UPDATE OR DELETE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION mealscout_track_public_link_source();

CREATE OR REPLACE FUNCTION mealscout_track_public_link_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR jsonb_build_array(to_jsonb(NEW)->'is_disabled',
    to_jsonb(NEW)->'public_profile_settings') IS DISTINCT FROM
    jsonb_build_array(to_jsonb(OLD)->'is_disabled',
      to_jsonb(OLD)->'public_profile_settings') THEN
    -- Native owner updates already lock restaurants in migration140 before
    -- touching optional authority. Keep that order for DELETE and when the
    -- native trigger is absent too. Source updates lock restaurant -> authority.
    PERFORM id FROM restaurants WHERE owner_id = OLD.id ORDER BY id FOR UPDATE;
    UPDATE mealscout_public_link_authority SET
      native_revision = native_revision + 1,
      authority_revision = authority_revision + 1, state = 'revoked',
      approved_native_revision = NULL, approved_content_digest = NULL,
      approved_at = NULL, expires_at = NULL WHERE owner_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS mealscout_public_link_owner ON users;
DROP TRIGGER IF EXISTS zz_mealscout_public_link_owner ON users;
-- PostgreSQL runs same-kind row triggers alphabetically. Native migration140's
-- trigger_owner_ordering_authority_after_update must acquire its restaurant
-- dependencies before this optional trigger acquires any authority record.
CREATE TRIGGER zz_mealscout_public_link_owner AFTER UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION mealscout_track_public_link_owner();

-- Add permission metadata only, without approving or changing native profiles.
INSERT INTO mealscout_public_link_authority
  (source_id, generation_id, public_tenant_id, owner_id)
SELECT id, replace(gen_random_uuid()::text, '-', ''),
  replace(gen_random_uuid()::text, '-', ''), owner_id FROM restaurants
ON CONFLICT (source_id) DO NOTHING;
