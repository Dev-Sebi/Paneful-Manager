import { fileURLToPath, URL } from 'node:url'
import Vue from '@vitejs/plugin-vue'
import { defineConfig, type UserConfig } from 'vitest/config'

export default defineConfig({
  // Vitest bundles its own Vite major, so the plugin type is bridged.
  plugins: [Vue() as unknown as NonNullable<UserConfig['plugins']>[number]],
  resolve: { alias: { '@': fileURLToPath(new URL('src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
