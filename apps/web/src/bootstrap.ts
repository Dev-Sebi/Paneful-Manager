/**
 * bootstrap.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

// Composables
import { createApp } from 'vue'

import { consumeLoginFragment, initAccess } from '@/api/access'
// Plugins
import { registerPlugins } from '@/plugins'

// Components
import App from './App.vue'

// Styles
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-700.css'
import '@fontsource/jetbrains-mono/latin-ext-400.css'
import '@fontsource/jetbrains-mono/latin-ext-700.css'
import '@/styles/generated/tokens.css'
import '@/styles/base.css'
import '@/styles/motion.css'

// Before the router reads the URL, so the key never shows up in a route or the history.
initAccess()
// Opening the login URL in a tab that already shows the app only changes the fragment.
window.addEventListener('hashchange', () => {
  if (consumeLoginFragment()) {
    location.reload()
  }
})

// No beforeunload or visibilitychange handler may call the API: closing the browser or unfocusing a tab never kills sessions.
const app = createApp(App)

registerPlugins(app)

app.mount('#app')
