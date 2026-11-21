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
    <div className="settings">
      <header className="page-intro"><div><h1 tabIndex={-1}>Settings</h1></div></header>
      <section aria-labelledby="appearance-heading" className="settings-group settings-row">
        <div>
          <h2 id="appearance-heading">Appearance</h2>
          <p className="muted">System follows this device.</p>
        </div>
        <fieldset className="segmented">
          <legend className="sr-only">Appearance</legend>
          {themes.map((option) => (
            <label key={option}>
              <input type="radio" name="appearance" checked={theme === option} onChange={() => onTheme(option)} />
              {option}
            </label>
          ))}
        </fieldset>
        {storageError ? <p role="alert" className="form-error">This browser could not store your appearance for next time.</p> : null}
      </section>
      <BackupPanel onRestore={onRestore} />
      <section aria-labelledby="data-heading" className="settings-group">
        <h2 id="data-heading">Privacy</h2>
        <p className="muted">Your library stays in this browser. Catalog searches send search text or catalog IDs to TMDB and IGDB, and artwork loads from their servers. Search text is kept out of our logs.</p>
      </section>
      <section aria-labelledby="install-heading" className="settings-group">
        <h2 id="install-heading">Install</h2>
        <p className="muted">Use your browser’s install option, or Add to Home Screen in Safari. After one online visit, saved titles work offline.</p>
      </section>
      <section aria-labelledby="credits-heading" className="settings-group settings-credits">
        <h2 id="credits-heading">Credits</h2>
        <a className="provider-logo" href="https://www.themoviedb.org"><img src="/credits/tmdb.svg" alt="The Movie Database" width="112" /></a>
        <p className="muted">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p className="muted">Game metadata and cover images are provided by <a className="text-link" href="https://www.igdb.com">IGDB</a>.</p>
      </section>
    </div>
  )
}
