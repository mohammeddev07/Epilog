import js from '@eslint/js'
import hooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import ts from 'typescript-eslint'

export default [
  { ignores: ['dist/**', '.wrangler/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    ...hooks.configs.flat.recommended,
  },
  {
    files: ['worker/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/test/**'], message: 'Worker code must not import test files.' }] }] },
  },
]
