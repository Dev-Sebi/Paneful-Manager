import { fileURLToPath, URL } from 'node:url'
import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'

const apiTarget = `http://127.0.0.1:${process.env.PANEFUL_MANAGER_PORT ?? '7337'}`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    Vue({
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
    Vuetify({
      autoImport: true,
      styles: {
        configFile: 'src/styles/settings.scss',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('src', import.meta.url)),
    },
    extensions: [
      '.js',
      '.json',
      '.jsx',
      '.mjs',
      '.ts',
      '.tsx',
      '.vue',
    ],
  },
  optimizeDeps: {
    // Used only by lazy views and auto-imported by Vuetify, so Vite finds them late and reloads the page mid-load on a cold cache.
    include: ['VCheckbox', 'VProgressCircular', 'VRadio', 'VRadioGroup', 'VSelect', 'VSwitch', 'VTextField', 'VTextarea'].map(name => `vuetify/components/${name}`),
  },
  server: {
    // The bound address, not `localhost`: another local user could listen on `::1` with the same port.
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
})
