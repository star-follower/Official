# Star Follower

Static React web application for purchasing Instagram growth services with coins.

## Run & Operate

- `node server.js` — serve the application on port 5000
- No environment variables are required by the current static server.

## Stack

- Node.js static file server
- Prebuilt React 19 / Vite browser bundle
- TanStack Query for browser-side server state
- Supabase browser client for data access

## Where things live

- `server.js` — static server and APK download proxy
- `index.html` — app bootstrap and Android WebView compatibility layer
- `assets/index-B3WfkW1_.js` — imported production React bundle
- `supabase-api.js` — browser-side `/api/*` to Supabase adapter and view cache

## Architecture decisions

- The imported repository does not include the original React `src/` tree or source maps. Targeted React changes are applied reproducibly by the bootstrap loader before importing the production bundle.
- View-level API results are persisted separately from low-level transport responses so React can render cached data synchronously and then update from a fresh background request.
- The authenticated shell remains mounted across hash routes; only the inner view transitions.

## Product

- Login and account recovery
- Coin balance, service ordering, order history, referrals, and offer/CPA earning views

## User preferences

- Do not push workspace changes to GitHub automatically.

## Gotchas

- Keep bundle replacement strings synchronized with `assets/index-B3WfkW1_.js`; a changed upstream bundle may require updating those exact transforms.
- Preserve the 15-second minimum refresh window for profile coin and order queries.

## Pointers

- The original authored React source is not present in this import; the attached archive contains the same production bundle.
