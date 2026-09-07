---
name: Android WebView touch locks
description: Global scroll-isolation listeners from compiled UI bundles can strand touch input after back navigation.
---

When a compiled UI bundle is embedded in an Android WebView, inspect generated document-level `touchmove` and `touchstart` listeners when hardware-back freezes input. Disable incompatible global scroll-lock listeners before importing the bundle, and let native touch handling remain passive.

**Why:** Some WebViews retain the scroll-lock state after a `popstate` transition, leaving the page visually rendered but unable to receive taps.

**How to apply:** Treat back handling as a non-canceling reset: restore body/root pointer events, hide transient overlays directly, and avoid `preventDefault()` or propagation cancellation on navigation or touch events.

For freezes that occur before any tap, put the pointer-events rescue as the
first child of `body`, and yield auth/client bootstrap and compiled-bundle
loading through timers or async promises so initialization cannot occupy the
first WebView input frame.

**Why:** A stale WebView interaction state can be established during startup,
not only while opening or closing a modal; visually correct first paint does
not prove that the first touch task is free.

**How to apply:** Keep the inline rescue tiny and unconditional, add global
error/rejection recovery, and defer storage-backed auth checks, Supabase
client construction, session reconciliation, and initial data work until
after the browser has yielded once.