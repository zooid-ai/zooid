---
'@zooid/transport-matrix': patch
---

`zooid_get_recent_threads` fills each page even when thread replies crowd the timeline. Tuwunel ignores `not_rel_types` on `/messages`, so replies used to use up the page and leave it thin or empty. The provider now fetches in batches of at least 50 events, up to 5 rounds, and re-requests the last batch exactly so no entry is skipped.
