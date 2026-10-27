import vuetify from 'eslint-config-vuetify'
import tseslint from 'typescript-eslint'

// Every option is explicit: the defaults are auto-detected from process.cwd(), which made lint results environment-dependent.
const web = await vuetify({
  ts: true,
  vue: true,
  stylistic: true,
  perfectionist: true,
  imports: true,
  js: true,
  regexp: true,
  unicorn: true,
  json: true,
  antfu: true,
  ignore: true,
  pnpm: true,
  test: false,
  gitignore: false,
  autoimports: false,
  isInEditor: false,
})

// A config with only `ignores` (plus an optional name) is global; adding `files` would turn it into a local ignore.
const isGlobalIgnore = config => config.ignores !== undefined && Object.keys(config).every(key => key === 'ignores' || key === 'name')

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.claude/**',
      '**/.claude/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/.vite/**',
      'docs/**',
      'examples/**',
    ],
  },
  ...web.map(config => isGlobalIgnore(config)
    ? config
    : { ...config, files: config.files ?? ['apps/web/**/*.{js,ts,vue}'] }),
  {
    files: ['apps/web/**/*.vue'],
    rules: { 'vue/attribute-hyphenation': ['error', 'always', { ignore: ['ariaLabel'] }] },
  },
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
          message: 'Use run() from src/process/exec.ts (argument array, no shell).',
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
          selector: 'CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork)$/] Property:matches([key.name="shell"], [key.value="shell"]):not([value.value=false])',
          message: 'Never run processes through a shell.',
        },
        {
          selector: 'CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork)$/][arguments.2.type!="ObjectExpression"][arguments.length>2], CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork)$/] > ObjectExpression > SpreadElement',
          message: 'Pass process options as an inline object literal so the shell ban stays checkable.',
        },
      ],
    },
  },
]
