-- Reserve one Step 1 email attempt per normalized address before calling the
-- provider. Pending claims are deliberately not eligible for the drip sequence.
CREATE TABLE IF NOT EXISTS host_partner_email_claims (
  email_normalized text NOT NULL,
  sequence varchar NOT NULL,
  step integer NOT NULL,
  lead_id varchar REFERENCES host_partner_leads(id) ON DELETE SET NULL,
  status varchar NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted')),
  claimed_at timestamp NOT NULL DEFAULT now(),
  accepted_at timestamp,
  CONSTRAINT pk_host_partner_email_claims
    PRIMARY KEY (email_normalized, sequence, step)
);

-- Legacy Step 1 markers mean the provider previously returned acceptance.
-- The old drip wrote Steps 2 and 3 even when the provider returned false, so
-- those markers must remain pending/ambiguous and must not trigger a resend.
-- Multiple historical leads can share an address; choose one deterministic
-- representative without deleting or changing any lead or send row.
INSERT INTO host_partner_email_claims (
  email_normalized, sequence, step, lead_id, status, claimed_at, accepted_at
)
SELECT DISTINCT ON (lower(btrim(lead.email)), send.sequence, send.step)
  lower(btrim(lead.email)), send.sequence, send.step, send.lead_id,
  CASE WHEN send.step = 1 THEN 'accepted' ELSE 'pending' END,
  coalesce(send.sent_at, now()),
  CASE WHEN send.step = 1 THEN coalesce(send.sent_at, now()) ELSE NULL END
FROM host_partner_lead_sequence_sends AS send
JOIN host_partner_leads AS lead ON lead.id = send.lead_id
WHERE send.sequence = 'host_partner_v1'
  AND send.step IN (1, 2, 3)
  AND length(btrim(lead.email)) > 0
ORDER BY lower(btrim(lead.email)), send.sequence, send.step,
  send.sent_at ASC NULLS LAST, send.lead_id ASC
ON CONFLICT (email_normalized, sequence, step) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_host_partner_leads_email_normalized
  ON host_partner_leads (lower(btrim(email)));
