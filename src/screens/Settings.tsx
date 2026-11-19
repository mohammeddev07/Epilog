import { BackupPanel } from '../ui/BackupPanel'

export const themes = ['system', 'light', 'dark'] as const
export type Theme = (typeof themes)[number]
export const appearanceKey = 'epilog:appearance:v1'

export function Settings({ theme, onTheme, storageError, onRestore }: {
  theme: Theme
  onTheme: (theme: Theme) => void
  storageError: boolean
  onRestore: (count: number) => void
}) {
  return (
    <>
      <header className="page-intro"><div><h1 tabIndex={-1}>Settings</h1></div></header>
      <section aria-labelledby="appearance-heading" className="settings-panel">
        <h2 id="appearance-heading">Appearance</h2>
        <p className="muted">System follows this device’s appearance.</p>
        <fieldset className="status-options themes">
          <legend className="sr-only">Appearance</legend>
          <div>
            {themes.map((option) => (
              <label key={option}>
                <input type="radio" name="appearance" checked={theme === option} onChange={() => onTheme(option)} />
                {option}
              </label>
            ))}
          </div>
        </fieldset>
        {storageError ? <p role="alert" className="form-error">This browser could not store your appearance for next time.</p> : null}
      </section>
      <BackupPanel onRestore={onRestore} />
      <section aria-labelledby="data-heading" className="settings-panel">
        <h2 id="data-heading">Your data</h2>
        <p>Your tracking data stays in this browser. Export a backup before clearing browser data or moving to another device.</p>
        <p>When you use the catalog, Epilog sends search text or catalog IDs to TMDB and IGDB. Artwork loads from their image servers. The catalog service keeps search text out of its logs.</p>
      </section>
      <section aria-labelledby="install-heading" className="settings-panel">
        <h2 id="install-heading">Install Epilog</h2>
        <p>Use your browser’s install option, or choose Add to Home Screen in Safari. Once Epilog has loaded online, you can open it again and edit saved titles offline.</p>
      </section>
      <section aria-labelledby="credits-heading" className="settings-panel">
        <h2 id="credits-heading">Catalog credits</h2>
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <a className="provider-logo" href="https://www.themoviedb.org"><img src="/credits/tmdb.svg" alt="The Movie Database" width="112" /></a>
        <p>Game metadata and cover images are provided by <a className="text-link" href="https://www.igdb.com">IGDB</a>.</p>
      </section>
    </>
  )
}
