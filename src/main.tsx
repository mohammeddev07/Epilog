import '@fontsource-variable/schibsted-grotesk/wght.css'
import './ui/tokens.css'
import './ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'

import { motionProperties } from './ui/motion'

for (const [name, value] of Object.entries(motionProperties)) {
  document.documentElement.style.setProperty(name, String(value))
}

const root = document.getElementById('root')
if (!root) throw new Error('App root is missing.')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
