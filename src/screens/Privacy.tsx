const contact = 'PRIVACY_CONTACT_EMAIL'

export function Privacy() {
  return (
    <article className="privacy">
      <header className="page-intro">
        <div><h1 tabIndex={-1}>Privacy policy</h1><p>Signing in is optional. As a guest, your library stays in this browser and nothing about it is stored on Epilog’s server.</p></div>
      </header>
      <section aria-labelledby="privacy-stored">
        <h2 id="privacy-stored">What’s stored</h2>
        <p>When you sign in with Google, Epilog stores:</p>
        <ul>
          <li>Your Google account ID, email address and name, as Google shares them at sign-in.</li>
          <li>Your tracking records: statuses, completion dates, watched episodes, reading progress, playtime, likes, ratings, Watchlist, labels you enter, and each title’s format, book type and anime flag.</li>
          <li>Catalog IDs, which say which TMDB, IGDB or Open Library title a record is about. Titles, descriptions and artwork are not stored; your devices look them up from the catalogs.</li>
          <li>A sign-in session, kept in a secure cookie that only Epilog’s server can read.</li>
        </ul>
      </section>
      <section aria-labelledby="privacy-where">
        <h2 id="privacy-where">Where it’s stored</h2>
        <p>On Cloudflare, which runs Epilog’s server and database. Your library is also kept in each browser you use Epilog in.</p>
        <p>Catalog lookups send search text or catalog IDs to TMDB, IGDB and Open Library through Epilog’s server. Artwork loads from their servers. Signing in loads Google’s sign-in button, and Google’s privacy policy covers what Google does at sign-in.</p>
      </section>
      <section aria-labelledby="privacy-use">
        <h2 id="privacy-use">How it’s used</h2>
        <p>Only to sync your library between your devices. There’s no analytics, no advertising, and your data is never sold or shared.</p>
      </section>
      <section aria-labelledby="privacy-deletion">
        <h2 id="privacy-deletion">Deleting your data</h2>
        <p>Delete your account in Settings. That erases your account, its sessions and every synced record from Epilog’s server at once. Each device keeps its own copy until you remove it there, by signing out with “Remove it from this device” or clearing the site’s data in your browser.</p>
      </section>
      <section aria-labelledby="privacy-retention">
        <h2 id="privacy-retention">How long it’s kept</h2>
        <p>Until you delete your account. Inactive accounts are not purged. When you remove a title, a deletion marker without its details stays for 180 days so your other devices learn about the removal.</p>
      </section>
      <section aria-labelledby="privacy-contact">
        <h2 id="privacy-contact">Contact</h2>
        <p>Questions or requests: <a className="text-link" href={`mailto:${contact}`}>{contact}</a></p>
      </section>
    </article>
  )
}
