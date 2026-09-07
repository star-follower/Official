---
name: Android WebView touch locks
description: Global scroll-isolation listeners from compiled UI bundles can strand touch input after back navigation.
---

When a compiled UI bundle is embedded in an Android WebView, inspect generated document-level `touchmove` and `touchstart` listeners when hardware-back freezes input. Disable incompatible global scroll-lock listeners before importing the bundle, and let native touch handling remain passive.

**Why:** Some WebViews retain the scroll-lock state after a `popstate` transition, leaving the page visually rendered but unable to receive taps.

**How to apply:** Treat back handling as a non-canceling reset: restore body/root pointer events, hide transient overlays directly, and avoid `preventDefault()` or propagation cancellation on navigation or touch events.