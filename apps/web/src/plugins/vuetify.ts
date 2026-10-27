/**
 * plugins/vuetify.ts
 *
 * Framework documentation: https://vuetifyjs.com`
 */

// Composables
import { createVuetify } from 'vuetify'
import { loadUiPrefs } from '@/stores/ui'
import { darkTheme, lightTheme } from '@/styles/generated/theme'
// Styles
import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'

// https://vuetifyjs.com/en/introduction/why-vuetify/#feature-guides
export default createVuetify({
  theme: {
    defaultTheme: loadUiPrefs().theme ?? 'dark',
    themes: { dark: darkTheme, light: lightTheme },
  },
})
