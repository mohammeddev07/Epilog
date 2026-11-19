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

The public app runs at [epilog.pages.dev](https://epilog.pages.dev). Cloudflare Pages serves the Vite assets and forwards `/api/*` to the `epilog` Worker through a service binding. The Worker holds the catalog credentials, applies a per-location request limit, and has invocation logging and tracing disabled. Use the Cloudflare Free plan.

1. Authenticate with `npx wrangler login` and confirm the target account with `npx wrangler whoami`.
2. Run `npm run deploy:check` to build the app and verify the Worker bundle.
3. Run `npx wrangler deploy --secrets-file .env.catalog.local` from the project directory if the file contains only the three catalog credentials. Wrangler uploads them as server-held secrets.
4. Run `npx wrangler pages deploy --cwd pages --branch release` to publish the Pages frontend.
5. Open the Pages URL on desktop and phone. Install the app, log a title, and verify that the Library opens and accepts edits offline after its first online load.

The original Workers URL remains available for exporting an existing library. Restore that backup from Settings on the Pages URL to bring over its tracking history.

### Releases from GitHub Actions

[Release workflow](.github/workflows/release.yml) tests and deploys pushes to `release`, including merged pull requests. After Cloudflare accepts the deployment, it publishes a GitHub release and tag. The first tag comes from `package.json`. Later releases increment the latest stable tag’s patch version unless `package.json` specifies a higher version.

Create the `release` branch before the first production merge. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets, preferably on the `production` environment. Scope the token to the Cloudflare account that owns Epilog and grant Workers Scripts Edit and Cloudflare Pages Edit. The catalog credentials stay in the deployed Worker’s secret bindings. [Cloudflare’s CI authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#1-authentication).

Once the workflow is on GitHub’s default branch, select **Actions → Release → Run workflow** and enter an existing tag from `release` history, such as `v0.1.0`. This builds and deploys the selected revision to the production Worker and Pages project using its Wrangler configuration. It creates no additional GitHub release. [GitHub’s manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Epilog sends catalog search text in a POST body. The Worker sends title queries to TMDB and IGDB as their APIs require. Artwork loads from the providers’ CDNs. Personal statuses, dates, hours, and episode activity stay in the browser.
