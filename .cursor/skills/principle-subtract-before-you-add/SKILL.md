---
name: principle-subtract-before-you-add
description: Apply when sequencing an addition, refactor, or rewrite. Remove dead code, redundant validators, and stub references first, then build on the simpler base.
---

# Subtract Before You Add

Remove complexity first, then build. Leave the design slightly simpler behind the same or smaller surface.

- Sequence removal before construction.
- Cut before you polish.
- Design for observed usage, not speculative edge cases.
- No speculative validators, parsers, or guards beyond what the spec demands.
- Simplify prompts (remove redundant instructions).
- Delete references with no novel content instead of leaving stubs.
