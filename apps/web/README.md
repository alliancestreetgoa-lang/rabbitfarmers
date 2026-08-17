# apps/web — the web dashboard

A Vite + React + TypeScript + Tailwind v4 SPA, in shadcn/ui layout, sharing
`apps/api`. Sign-in is the only real screen so far.

## Run it

```bash
npm install
npm run dev            # http://localhost:5174
```

It needs the API. Start the whole stack from the repo root first:

```bash
API_PORT=3007 PORT=8080 ./scripts/localhost.sh
```

`vite.config.ts` proxies `/api` to `http://localhost:3007`. Point it elsewhere
with `API_ORIGIN=http://localhost:3000 npm run dev`.

**Why a proxy at all**: a deploy serves this app and the API from ONE origin, so
the app calls a relative `/api` and never needs to know an address — the same
thing `netlify.toml` does for the Expo build. Locally there are two processes, so
the dev server has to pretend there is one.

## Adding components

`components.json` is set up, so the shadcn CLI works:

```bash
npx shadcn@latest add button
```

Components land in `src/components/ui`. That path is not a convention worth
fighting: it is what `components.json` declares, what the CLI writes to, and what
every generated `@/components/ui/...` import expects. Move it and every `add`
lands somewhere your imports do not look.

The `@` alias is declared in three places that must agree — `vite.config.ts`,
`tsconfig.app.json` and `components.json`. A mismatch resolves in the editor and
fails in the build.

## Design tokens

`src/index.css` defines `--color-farm-*` in an `@theme` block, lifted from
`apps/mobile/src/ui/theme.ts` so the web and the phone cannot drift into two
different greens. Use `bg-farm-accent`, `text-farm-muted` and so on rather than
raw hex.

## Not done yet

- Not deployed. `netlify.toml` still publishes `apps/mobile/dist` at `/`; giving
  this app the root means moving the Expo build to `/app/*` and updating the
  redirect table plus `apps/api/test/routing.test.js`, which guards it.
- No dashboard. `/dashboard` and `/signup` are placeholders.
- No tests.
