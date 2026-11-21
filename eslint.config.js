import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      // Committed build outputs; never lint generated bundles.
      'panel/main.js',
      'page/main.js',
      'service/main.js',
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
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: {
      // Build scripts may exit with process codes.
      'no-process-exit': 'off',
    },
  },
);
