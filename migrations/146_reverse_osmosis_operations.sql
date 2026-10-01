CREATE TABLE IF NOT EXISTS reverse_osmosis_operations (
 operation_key varchar(64) PRIMARY KEY,
 payload_digest varchar(64) NOT NULL,
 draft_id varchar NOT NULL REFERENCES owner_ai_action_drafts(id) ON DELETE CASCADE,
 restaurant_id varchar NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
 owner_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 approved_revision integer NOT NULL CHECK (approved_revision > 0),
 approval_id varchar(512) NOT NULL,
 proposal jsonb NOT NULL,
 status varchar NOT NULL CHECK (status IN ('claimed','completed','denied','held','reflected')),
 receipt jsonb,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reverse_osmosis_operations_owner_draft_idx ON reverse_osmosis_operations(owner_id,draft_id);
