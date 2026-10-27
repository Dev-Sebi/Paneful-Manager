import vuetify from 'eslint-config-vuetify'
import tseslint from 'typescript-eslint'

const web = await vuetify({ ts: true })

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...web.map(config => ({ ...config, files: config.files ?? ['apps/web/**/*.{js,ts,vue}'] })),
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts'],
  })),
]
