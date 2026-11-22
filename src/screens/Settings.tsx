import { useState } from 'react'
import { readDefaultSort, sorts, sortPreferenceKey } from '../ui/library-preferences'
import type { SortKey } from '../ui/library-preferences'
import { BackupPanel } from '../ui/BackupPanel'
import { Link } from 'react-router'
import { useGoogleClientId } from '../data/account'
import { AccountPanel } from '../ui/AccountPanel'
import { SelectionIndicator } from '../ui/SelectionIndicator'

export const themes = ['system', 'light', 'dark'] as const
export type Theme = (typeof themes)[number]
export const appearanceKey = 'epilog:appearance:v1'

export function Settings({ theme, onTheme, storageError, onRestore }: {
  theme: Theme
  onTheme: (theme: Theme) => void
  storageError: boolean
  onRestore: (count: number) => void
}) {
  const [sort, setSort] = useState(readDefaultSort)
  const [sortError, setSortError] = useState(false)
  const signInConfigured = Boolean(useGoogleClientId())
  function changeSort(value: SortKey) {
    try {
      localStorage.setItem(sortPreferenceKey, value)
      setSort(value)
      setSortError(false)
    } catch { setSortError(true) }
  }
  return (
    <div className="settings">
      <header className="page-intro"><div><h1 tabIndex={-1}>Settings</h1></div></header>
      <AccountPanel />
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
              {theme === option && <SelectionIndicator id="appearance-selection" />}
              {option}
            </label>
          ))}
        </fieldset>
        {storageError ? <p role="alert" className="form-error">This browser could not store your appearance for next time.</p> : null}
      </section>
      <section aria-labelledby="library-preferences" className="settings-group">
        <h2 id="library-preferences">Library Preferences</h2>
        <label className="field">Default library sort
          <select className="control" value={sort} onChange={(event) => changeSort(event.target.value as SortKey)}>
            {Object.entries(sorts).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
          </select>
        </label>
        {sortError && <p role="alert" className="form-error">Couldn’t save your sorting preference in this browser.</p>}
      </section>
      <BackupPanel onRestore={onRestore} />
      <section aria-labelledby="app-info" className="settings-group settings-credits">
        <h2 id="app-info">App Information</h2>
        <h3>Privacy</h3>
        <p className="muted">As a guest, your library stays in this browser.{signInConfigured ? ' Signed in, Epilog’s server also keeps your tracking records and catalog IDs so your devices stay in sync.' : ''} Catalog lookups send search text or catalog IDs to the relevant providers, and artwork loads from their servers. <Link to="/privacy" className="text-link">Privacy policy</Link></p>
        <h3>Install</h3>
        <p className="muted">Use your browser’s install option, or Add to Home Screen in Safari. After one online visit, saved titles work offline.</p>
        <h3>Catalog credits</h3>
        <a className="provider-logo" href="https://www.themoviedb.org"><img src="/credits/tmdb.svg" alt="The Movie Database" width="112" /></a>
        <p className="muted">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p className="muted">Game metadata and cover images are provided by <a className="text-link" href="https://www.igdb.com">IGDB</a>.</p>
        <p className="muted">Book discovery and covers are provided by <a className="text-link" href="https://openlibrary.org">Open Library</a>.</p>
      </section>
    </div>
  )
}
