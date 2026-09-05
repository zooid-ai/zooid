---
"zooid": patch
---

Fix `zooid --version`, which reported `0.0.1` on every build from the first
release through 0.12.0. The version was a hardcoded literal in `bin.ts`; it is
now read from the package manifest at startup, so it can't drift from the
installed release again.
