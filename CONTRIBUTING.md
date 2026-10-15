# Contributing

Development commands for this repo. How to run dureview is in the [README](README.md). Posting rules, the archive, and the web UI are in [docs/reference.md](docs/reference.md).

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run e2e
npm run build
```

`npm test` runs Vitest. `npm run e2e` runs `test/e2e.test.ts`. Tests use pi-ai's faux model and an in-memory GitHub client. They boot an in-process `node:http` listener (`startHttp`) so they can call the same helpers without Vite. That listener is not the production server. Production is `npm start` (`node dist/cli.js serve`), which loads the built TanStack Start server.

Live Codex OAuth and a real GitHub App are not exercised here. `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` are pinned at 1.1.0.

Run one process against a data directory. Pi Durable storage is not locked across processes.
