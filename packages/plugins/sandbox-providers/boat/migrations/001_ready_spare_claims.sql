CREATE TABLE plugin_boat_sandbox_provider_8f6adf7263.boat_spare_claims (
  provider_lease_id text PRIMARY KEY,
  company_id text NOT NULL,
  environment_id text NOT NULL,
  claim_token text NOT NULL,
  run_id text NOT NULL,
  claimed_at timestamptz NOT NULL
);
