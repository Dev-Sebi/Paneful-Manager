import vuetify from 'eslint-config-vuetify'
import tseslint from 'typescript-eslint'

const web = await vuetify({ ts: true })

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', 'examples/**'] },
  ...web.map(config => ({ ...config, files: config.files ?? ['apps/web/**/*.{js,ts,vue}'] })),
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts'],
  })),
  {
    // Processes are started with argument arrays only (see apps/server/src/process/exec.ts).
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['child_process', 'node:child_process'].map(name => ({
          name,
          importNames: ['exec', 'execSync'],
          message: 'Use run() from src/process/exec.ts (execFile, no shell).',
        })),
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'ImportDeclaration[source.value=/^(node:)?child_process$/] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)',
          message: 'Import named child_process functions so the exec ban stays enforceable.',
        },
        {
          selector: 'ImportExpression[source.value=/^(node:)?child_process$/]',
          message: 'Import child_process statically so the exec ban stays enforceable.',
        },
        {
          selector: 'Property[key.name="shell"]:not([value.value=false])',
          message: 'Never run processes through a shell.',
        },
      ],
    },
  },
]
