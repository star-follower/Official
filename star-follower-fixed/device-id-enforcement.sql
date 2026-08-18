-- One account per persistent device UUID.
-- Apply this after the base schema. It is intentionally partial so legacy
-- empty device IDs do not prevent existing accounts from remaining usable.
CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_unique
  ON public.users (device_id)
  WHERE device_id IS NOT NULL AND btrim(device_id) <> '';