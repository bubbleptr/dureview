---
name: react-best-practices
description: React/TSX checklist (Vercel). Use when writing or reviewing React components in this repo.
---

# React best practices (condensed)

Highest impact first:
1. **No waterfalls**: start independent async work in parallel (`Promise.all`), await late, load data in route loaders rather than chained effects.
2. **Bundle size**: import modules directly (no barrel files); lazy-load heavy, rarely used components; no new third-party deps without need.
3. **Server/SSR**: no module-level mutable per-request state; pass only the data the client needs; keep SSR and client output identical (no hydration mismatch).
4. **Client data**: dedupe global event listeners; passive scroll listeners; version and minimize localStorage data and handle missing/invalid values.
5. **Re-renders**: derive state during render instead of syncing with effects; put interaction logic in event handlers; functional setState; primitive effect deps; never define components inside components.
6. **Rendering**: use ternaries not `&&` for conditional JSX with numbers; `content-visibility`/virtualization for long lists; respect `prefers-reduced-motion`.
7. **JS**: Map/Set for repeated lookups, early returns, hoist RegExp, `toSorted()` over in-place sort.
8. **Accessibility**: semantic elements, labels for inputs, keyboard reachable controls, visible focus, sufficient contrast in light and dark.

UI changes must also follow `design.md`.
