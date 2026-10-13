/**
 * Base-branch config returned by the in-DO GitHub stand-in.
 * `trigger: auto` is what `test/e2e.test.ts` puts on the GitHub file.
 * `summary` and the rule text match `test/fixtures/repo/.dureview.md`.
 */
export const FIXTURE_DUREVIEW = `---
trigger: auto
summary: true
---

Flag success returned without calling the payment gateway.
Ignore formatting.
`;

export const FIXTURE_DIFF = `diff --git a/src/pay.ts b/src/pay.ts
index 1111111..2222222 100644
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,5 +1,6 @@
 export function charge(amount: number): { ok: boolean } {
-  return gateway.capture(amount);
+  if (amount > 0) return { ok: true };
+  return gateway.capture(amount);
 }
 
 const gateway = {
`;
