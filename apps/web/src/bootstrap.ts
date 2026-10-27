/**
 * bootstrap.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

// Composables
import { createApp } from 'vue'

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

// No beforeunload or visibilitychange handler may call the API: closing the browser or unfocusing a tab never kills sessions.
const app = createApp(App)

registerPlugins(app)

app.mount('#app')
