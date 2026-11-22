/* global localStorage, document */
// A blocking, same-origin head script also works under the installed PWA's CSP.
try {
  const preference = localStorage.getItem('epilog:appearance:v1')
  if (preference === 'light' || preference === 'dark') {
    document.documentElement.dataset.theme = preference
  }
} catch {
  // Storage may be disabled. The initial system preference still works.
}
