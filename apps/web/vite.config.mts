import type { IncomingMessage } from 'node:http'
import type { ProxyOptions } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'

const apiTarget = `http://127.0.0.1:${process.env.AGENT_HUB_PORT ?? '7337'}`
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/

/**
 * Same-origin requests from a loopback dev page get the API origin, so the server's Origin check
 * passes on any Vite port; foreign origins are forwarded untouched and still rejected.
 */
function forwardOrigin (proxyReq: { setHeader: (name: string, value: string) => void }, req: IncomingMessage) {
  const host = req.headers.host ?? ''
  if (LOOPBACK_HOST.test(host) && req.headers.origin === `http://${host}`) {
    proxyReq.setHeader('origin', apiTarget)
  }
}

function apiProxy (ws: boolean): ProxyOptions {
  return {
    target: apiTarget,
    changeOrigin: true,
    ws,
    configure: proxy => {
      proxy.on('proxyReq', (proxyReq, req) => forwardOrigin(proxyReq, req))
      proxy.on('proxyReqWs', (proxyReq, req) => forwardOrigin(proxyReq, req))
    },
  }
}

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
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': apiProxy(false),
      '/ws': apiProxy(true),
    },
  },
})
