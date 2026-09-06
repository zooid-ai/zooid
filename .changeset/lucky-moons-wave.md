---
"zooid": minor
---

Make the CLI explorable. `zooid help` and `zooid help <command>` now mirror
`--help`, every command carries usage examples, and the help footer links the
docs. A bare `zooid` prints help and exits 1 instead of doing nothing, and an
unknown command says so rather than exiting silently.
