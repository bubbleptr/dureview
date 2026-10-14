---
name: principle-prove-it-works
description: Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or "it compiles."
---

# Prove It Works

Verify every task output by checking the real thing directly. Do not infer from proxies, self-reports, or "it compiles."

- Check process liveness directly, not through derived state.
- Read the actual value, not a cached or derived representation.
- When verification fails, suspect the observation method before the system.
- Prefer a deterministic script that re-runs the check; keep its output (and screenshots for UI) as an artifact a reviewer can re-run.
