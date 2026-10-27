import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config.mts'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    server: { deps: { inline: ['vuetify'] } },
  },
}))
