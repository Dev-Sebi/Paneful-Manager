/**
 * plugins/index.ts
 *
 * Automatically included in `./src/main.ts`
 */

// Types
import type { App } from 'vue'

// Plugins
import pinia from './pinia'
import { createRouterPlugin } from './router'
import vuetify from './vuetify'

export function registerPlugins (app: App) {
  // Pinia first: the router guards read stores.
  app.use(pinia)
  app.use(vuetify)
  app.use(createRouterPlugin())
}
