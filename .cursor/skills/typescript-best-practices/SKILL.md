---
name: typescript-best-practices
description: TypeScript best practices. Use when reading or editing any .ts or .tsx file.
---

# TypeScript best practices

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states can't be represented. No optional-field bags. |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` so they can't be mixed up. Validate once at the boundary. |
| Constructive modeling | Build the shape so the illegal value can't be constructed (`[T, ...T[]]` for non-empty, `start` + `duration` for a range). |
| Simplest total type | Keep `T[]` while every operation stays total; strengthen only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. |
| Schemas before guards | Use the repo's runtime schema library and infer types from it instead of hand-written property guards. |
| No `as` casts | Cast only after validation. |
| Narrowing hierarchy | Discriminant switch > `in` > `typeof`/`instanceof` > user-defined type guard > `as`. |
| Type guards | Must verify the claim. Name them `isX` or `hasX`. |
| Exhaustiveness | `const _exhaustive: never = x;` in default arms. |
| `satisfies` over `as` | Validates without widening literal types. |
| Boundary validation | Parse where data crosses in into a named domain type; trust types inside. |
| Schema-derived types | Use `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring new interfaces. |
| Object args | Pass objects, not positional args (except hot paths). |
| Real tests | Don't mock what you can run; verify UI in a running build. |
| Structured telemetry | Structured logger with ids; no `console.log` in shipped code. |
