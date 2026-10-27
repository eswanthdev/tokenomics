import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', '.local/**', 'docs/screenshots/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  { files: ['public/*.js'], languageOptions: { globals: globals.browser } },
];
