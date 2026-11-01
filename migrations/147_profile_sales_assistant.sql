CREATE TABLE IF NOT EXISTS profile_sales_assistant_configs (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_kind varchar NOT NULL CHECK (profile_kind IN ('truck', 'host', 'vendor')),
  profile_id varchar NOT NULL,
  contract_version varchar NOT NULL DEFAULT 'mealscout.profile-sales-assistant.v1',
  enabled boolean NOT NULL DEFAULT true,
  solicitation_guard boolean NOT NULL DEFAULT true,
  marketing_opt_in_default boolean NOT NULL DEFAULT false,
  quote_policy varchar NOT NULL DEFAULT 'listed_items_only',
  defaults jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uq_profile_sales_assistant_profile UNIQUE (profile_kind, profile_id),
  CONSTRAINT profile_sales_assistant_guard CHECK (
    solicitation_guard = true
    AND marketing_opt_in_default = false
    AND quote_policy = 'listed_items_only'
  )
);

CREATE INDEX IF NOT EXISTS idx_profile_sales_assistant_kind
  ON profile_sales_assistant_configs (profile_kind);

CREATE TABLE IF NOT EXISTS profile_sales_inquiries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id varchar NOT NULL REFERENCES profile_sales_assistant_configs(id) ON DELETE CASCADE,
  profile_kind varchar NOT NULL,
  profile_id varchar NOT NULL,
  qualification jsonb NOT NULL,
  quote jsonb NOT NULL,
  completion jsonb NOT NULL,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  customer_name varchar,
  customer_email varchar,
  customer_phone varchar,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profile_sales_inquiries_profile
  ON profile_sales_inquiries (profile_kind, profile_id);
