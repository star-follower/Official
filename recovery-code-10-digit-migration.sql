-- Star Follower — Recovery code format migration
-- Run this once in Supabase for an existing database.
-- New and repaired codes are numeric and exactly 10 digits.

ALTER TABLE users
  ALTER COLUMN recovery_code SET DEFAULT floor(random() * 9000000000 + 1000000000)::BIGINT::TEXT;

UPDATE users
SET recovery_code = floor(random() * 9000000000 + 1000000000)::BIGINT::TEXT
WHERE recovery_code !~ '^[0-9]{10}$';

ALTER TABLE users
  ADD CONSTRAINT users_recovery_code_10_digits
  CHECK (recovery_code ~ '^[0-9]{10}$');