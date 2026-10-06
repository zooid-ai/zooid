---
'zooid': patch
---

`zooid dev` now fails immediately, with docker's stderr and exit code, when `docker run` for Tuwunel exits early, and removes a stale non-running `zooid-tuwunel` container left by an interrupted run (zooid#19). A running one is left alone with a clear error.
