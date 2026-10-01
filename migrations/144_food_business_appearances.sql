-- Additive native food-profile appearances. No grants, existing-row conversion or host/payment bookings.
CREATE TABLE IF NOT EXISTS food_business_appearances (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id VARCHAR NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  owner_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_type VARCHAR NOT NULL CHECK (profile_type IN ('restaurant','bar','caterer','private_chef')),
  date TIMESTAMP NOT NULL, start_time VARCHAR, end_time VARCHAR,
  location_name VARCHAR, address VARCHAR, city VARCHAR, state VARCHAR, notes VARCHAR,
  is_public BOOLEAN NOT NULL DEFAULT FALSE, status VARCHAR NOT NULL CHECK (status IN ('confirmed','closed','cancelled')),
  schedule_type VARCHAR, timezone VARCHAR, source_type VARCHAR, source_artifact VARCHAR, source_evidence JSONB,
  expires_at TIMESTAMP, last_confirmed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS food_business_appearances_profile_date_idx ON food_business_appearances(restaurant_id,profile_type,date);
