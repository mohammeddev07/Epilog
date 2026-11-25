# Epilog

**Every story you love, in one place.** Movies, TV shows, anime, games, and books, tracked in one library that's beautiful, fast, and private.

**[Open Epilog →](https://epilog.pages.dev)** Free, and you can start logging in seconds. Signing in is optional.

![The Epilog Dashboard picks up a TV series, a manga, and a game right where you left off](.github/screenshots/dashboard.png)

## Stop juggling five apps

Your movies are in one app, your games in another, your reading list in a notes file, and that anime you dropped halfway is lost somewhere. Epilog brings all of it together with one library, one Dashboard, and one place to see everything you've watched, played, and read.

## Track things the way they actually work

- **🎬 Movies.** Log a watch, rate it, like it, and log a rewatch whenever you go back.
- **📺 TV and anime.** Check off episodes one at a time or finish a whole season in one click. Epilog always knows what's next.
- **🎮 Games.** Record the hours you've played, from a quick indie to a 100-hour epic.
- **📚 Books.** Novels, nonfiction, light novels, manga, manhwa, and manhua. Track progress by page, chapter, or volume, whichever fits the book.

## Find your next favorite

<img src=".github/screenshots/phone-popular.png" alt="Swiping through Popular This Week on a phone, with Watched, Like, Rating, and Watchlist actions" width="280" align="right">

Every category comes with **Popular This Week**, **Highest Rated**, **Most Anticipated**, and a **Release Date** explorer that jumps to any decade or year. You can search millions of titles from TMDB, IGDB, and Open Library.

On your phone, swipe through what's popular like a deck of posters. One tap marks something watched, liked, rated, or added to your watchlist, and holding Watch logs the exact date.

## See your year in numbers

**Stats** turns your library into a story: hours watched and played, pages, chapters, and volumes read, books finished by type, your longest streak, your busiest month, and your favorite genres.

## Share your taste, not your data

Send a friend a link to your library and Epilog compares your tastes side by side. You'll see what you both loved and what they should try next. The whole profile travels inside the link, so there's no server and no account behind it. Your friend doesn't need to sign in.

<br clear="right">

## Yours, and only yours

- **🔒 Private by design.** Your library lives in your browser, and you don't need an account to use Epilog. If you choose to sign in with Google, your tracking records sync across your devices, along with the catalog IDs of the titles you track. Titles, descriptions, and artwork never leave your device. There's no analytics, no ads, and nothing is sold. You can delete your account and its data from Settings.
- **✈️ Works offline.** Install it on your phone or desktop. After one online visit, your saved titles open on a plane, on the subway, anywhere.
- **💾 Never lose a thing.** Export a backup in one tap and restore it on any device, with a preview of exactly what will change.
- **🌗 Looks great day or night.** Light, dark, or follow your system.

**Ready to build your library? [Start with Epilog now →](https://epilog.pages.dev)**

---

# For developers

## Local development

Use Node.js 22.12 or later and run `npm ci`. Create a git-ignored `.env.catalog.local` beside `package.json` with these three values.

```dotenv
TMDB_READ_ACCESS_TOKEN=
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=
```

Get the read access token from [TMDB API Settings](https://www.themoviedb.org/settings/api). Create an application with the Confidential client type in the [Twitch Developer Console](https://dev.twitch.tv/console/apps) for IGDB. Books use Open Library’s public API, which needs no key.

Sign-in and sync are optional. To try them locally, add `GOOGLE_CLIENT_ID=` with your OAuth client ID (see [Google sign-in and sync](#google-sign-in-and-sync)) to `.env.catalog.local`. It isn't a secret. While it's empty, the account routes return 404 and the app behaves as it does without sync. Local D1 needs the migrations applied once with `npx wrangler d1 migrations apply epilog --local`. To preview the privacy page’s email link, optionally set `PRIVACY_CONTACT_EMAIL` in the same local file.

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

`npm test` runs the Vitest and Chromium suites under `test/`. Playwright specs live in `test/e2e/` and use synthetic provider responses. `npm run test:catalog` makes authenticated TMDB and IGDB calls using local credentials and reports coverage without writing provider responses.

### Required check for develop

The [Develop validation workflow](.github/workflows/develop-validation.yml) runs lint, type checking, Vitest, and Chromium for pull requests and merge queue entries targeting `develop`. It runs again when a commit lands on `develop`.

To enforce it, let the workflow run on a pull request targeting `develop`. In the repository’s **Settings → Rules → Rulesets**, create an active branch ruleset targeting `develop`. Require a pull request before merging and require the **Develop tests** status check from GitHub Actions. Enable the up-to-date requirement if the branch uses regular pull request merges. Keep the bypass list empty if everyone must pass the check. [GitHub ruleset setup](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

## Personal deployment on Cloudflare

The public app runs at [epilog.pages.dev](https://epilog.pages.dev). Cloudflare Pages serves the Vite assets and forwards `/api/*` to the `epilog` Worker through a service binding. The Worker holds the catalog credentials, applies a per-location request limit, and has invocation logging and tracing disabled. Use the Cloudflare Free plan.

1. Authenticate with `npx wrangler login` and confirm the target account with `npx wrangler whoami`.
2. Run `npm run deploy:check` to build the app and verify the Worker bundle.
3. Run `npx wrangler deploy --secrets-file .env.catalog.local` from the project directory if the file contains only the three catalog credentials. Wrangler uploads them as server-held secrets.
4. Run `npx wrangler pages deploy --cwd pages --branch release` to publish the Pages frontend.
5. Open the Pages URL on desktop and phone. Install the app, log a title, and verify that the Library opens and accepts edits offline after its first online load.

The original Workers URL remains available for exporting an existing library. Restore that backup from Settings on the Pages URL to bring over its tracking history.

### Google sign-in and sync

Sign-in is optional and syncs the library across devices. It stores the Google account ID, email, and name, plus tracking records and catalog IDs, in a Cloudflare D1 database. It does not store titles, descriptions, or artwork. These steps need your own accounts, so they can't be automated.

1. In Google Cloud Console, create an OAuth client of type **Web application**. Add the authorized JavaScript origins `https://epilog.pages.dev`, `http://localhost:8787`, and `http://localhost`.
2. Configure the OAuth consent screen as **External**. Set the app name, the homepage `https://epilog.pages.dev`, the privacy policy `https://epilog.pages.dev/privacy`, the scopes `openid email profile`, and a developer contact email. Publish it, since only non-sensitive scopes are used.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**. Add `GOOGLE_CLIENT_ID` with your OAuth Web client ID. The release workflow supplies the value when it bundles the Worker. The browser uses this public client ID for Google Sign-In.
4. Run `npx wrangler d1 create epilog` and replace the `database_id` placeholder in `wrangler.jsonc` with the id it prints.
5. Apply the migrations with `npx wrangler d1 migrations apply epilog --remote`. The release workflow does this before each deploy.
6. Optionally add `PRIVACY_CONTACT_EMAIL` as another GitHub Actions repository secret. Use a public contact alias you’re comfortable displaying on the privacy page. Leave it unset to omit the link.

Until `GOOGLE_CLIENT_ID` is set, the account routes return 404 and Epilog works as it does without sign-in. Sync requests use the `SYNC_RATE_LIMITER` binding, and the Worker allows requests without it if the binding is missing.

D1's Free plan allows 100,000 rows written a day, and every index entry counts as a row. Each synced record writes about four rows, so a first merge of a 500-title library (about 2,500 records) writes about 10,000 rows, and an ordinary edit about ten. Syncs that change nothing write no rows. That allows about ten such first merges a day, or a few dozen to a hundred active people a day. Workers Paid lifts the limit.

### Releases from GitHub Actions

**Before the next release,** create the D1 database and set `database_id` in `wrangler.jsonc`. Every release, including the manual re-run, fails until you do, because the workflow applies the D1 migrations and `wrangler deploy` resolves the `DB` binding. Follow steps 3 to 5 of [Google sign-in and sync](#google-sign-in-and-sync) (steps 4 and 5 create the database and apply the migrations), then continue with the [Cloudflare deployment steps](#personal-deployment-on-cloudflare) as needed.

[Release workflow](.github/workflows/release.yml) tests and deploys pushes to `release`, including merged pull requests. After Cloudflare accepts the deployment, it publishes a GitHub release and tag. The first tag comes from `package.json`. Later releases increment the latest stable tag’s patch version unless `package.json` specifies a higher version.

Create the `release` branch before the first production merge. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets, preferably on the `production` environment. Scope the token to the Cloudflare account that owns Epilog and grant Workers Scripts Edit, Cloudflare Pages Edit, and D1 Edit. The catalog credentials stay in the deployed Worker’s secret bindings. The release workflow embeds `GOOGLE_CLIENT_ID` and `PRIVACY_CONTACT_EMAIL` in the server-side bundle without creating Cloudflare variable or secret bindings for them. Changes take effect on the next GitHub Actions deploy. [Cloudflare’s CI authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#1-authentication).

Once the workflow is on GitHub’s default branch, select **Actions → Release → Run workflow** and enter an existing tag from `release` history, such as `v0.1.0`. This builds and deploys the selected revision to the production Worker and Pages project using its Wrangler configuration. It creates no additional GitHub release. [GitHub’s manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Epilog sends catalog search text in a POST body. The Worker sends title queries to TMDB, IGDB, or Open Library for the selected media categories. Books can also be added manually from Search. Artwork loads from the providers’ CDNs. Personal statuses, dates, hours, episode activity, and reading progress stay in the browser unless you sign in, in which case they sync to your D1 database.
