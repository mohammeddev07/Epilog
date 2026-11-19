# Epilog

Epilog is an offline-capable personal library for movies, TV, anime, and games. Tracking data stays in IndexedDB. Use Settings to export or restore a portable JSON backup.

## Local development

Use Node.js 22.12 or later and run `npm ci`. Create a git-ignored `.env.catalog.local` beside `package.json` with these three values.

```dotenv
TMDB_READ_ACCESS_TOKEN=
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=
```

Get the read access token from [TMDB API Settings](https://www.themoviedb.org/settings/api). Create an application with the Confidential client type in the [Twitch Developer Console](https://dev.twitch.tv/console/apps) for IGDB.

Run `npm run dev` and open the Wrangler loopback URL for live catalog search and the installable PWA. Run `npm run dev:ui` for Vite hot reload with the fictional demo catalog. These modes use different local origins and maintain separate libraries.

## Verification

```sh
npx playwright install chromium
npm run build
npm run lint
npm run typecheck
npm test
npm run test:catalog
npm run deploy:check
```

`npm test` runs the unit, IndexedDB, Worker, and Chromium suites. Browser tests use synthetic provider responses. `npm run test:catalog` makes authenticated TMDB and IGDB calls using local credentials and reports coverage without writing provider responses.

## Personal deployment on Cloudflare

Use an account on the Workers Free plan. The configuration bundles Vite static assets and one catalog Worker. It routes `/api/*` through the Worker, applies a per-location request limit, and disables Workers invocation logging and tracing.

1. Authenticate with `npx wrangler login` and confirm the target account with `npx wrangler whoami`.
2. Run `npm run deploy:check` to build the app and verify the Worker bundle.
3. Run `npx wrangler deploy --secrets-file .env.catalog.local` from the project directory if the file contains only the three catalog credentials. Wrangler uploads them as server-held secrets.
4. Open the deployed HTTPS URL on desktop and phone. Install the app, log a title, and verify that the Library opens and accepts edits offline after its first online load.

Epilog sends catalog search text in a POST body. The Worker sends title queries to TMDB and IGDB as their APIs require. Artwork loads from the providers’ CDNs. Personal statuses, dates, hours, and episode activity stay in the browser.
