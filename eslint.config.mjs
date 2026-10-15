import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      '**/out/**',
      'release/**',
      '.claude/**',
      '.planning/**',
      'fixtures/**',
      '.tools/**',
      'node_modules/**',
      '**/node_modules/**',
      'logs/**',
      'proof/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    },
  },
)
