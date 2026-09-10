---
name: App settings compatibility
description: The live Supabase app_settings table may use key/value rows instead of named version columns.
---

The app settings reader must support both a single row containing
latest_version, update_url, and is_mandatory and a key/value table containing
those names as keys. Prefer a non-column-specific select when the live schema
is not controlled by migrations in this repository.

**Why:** The live table currently accepts select=* but rejects a named-column
select for latest_version, so a strict query produces a 400 before any update
modal decision can be made.

**How to apply:** Normalize returned rows into one settings object, treat
missing or malformed settings as "no update", and never let update-check
failures block app startup.