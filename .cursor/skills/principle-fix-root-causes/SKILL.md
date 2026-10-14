---
name: principle-fix-root-causes
description: Apply when debugging. Trace each symptom to its root cause and fix it there; reproduce first, ask why until you reach it, resist guards that silence crashes.
---

# Fix Root Causes

- Reproduce first.
- Ask "why" until you hit the root cause.
- Don't add guards that only silence a crash (symptom fix).
- If a workaround needs a paragraph-long comment to justify it, the code is wrong.
- Fix the pattern, not just the instance (grep for the same pattern).
- When stuck, instrument; don't guess.
- If the deciding fact took a deep dig to find, add the cheap always-on signal that would have shown it.
- "Fails after restart": suspect stale persistent state (config, caches, lock files, SQLite rows) before code.
