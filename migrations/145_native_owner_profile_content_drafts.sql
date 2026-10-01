-- Content-only public fields already read by the native public projectors.
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS instagram_url text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS facebook_page_url text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS x_url text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS cover_image_url text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS logo_url text;

CREATE TABLE IF NOT EXISTS owner_ai_native_profile_drafts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind varchar NOT NULL CHECK (target_kind IN ('host', 'supplier')),
  target_id varchar NOT NULL,
  owner_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  status varchar NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied', 'cancelled')),
  context_version varchar NOT NULL,
  content_hash varchar NOT NULL,
  packet jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  media_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent jsonb,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  applied_at timestamp
);
CREATE INDEX IF NOT EXISTS owner_ai_native_profile_drafts_owner_target_idx
  ON owner_ai_native_profile_drafts(owner_id, target_kind, target_id);
