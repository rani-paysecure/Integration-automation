// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const playwright = require('eslint-plugin-playwright');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: ['node_modules/', 'reports/', 'test-results/', 'playwright-report/', 'blob-report/'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      // Assertions frequently live in shared helpers / custom matchers.
      'playwright/expect-expect': [
        'warn',
        {
          assertFunctionNames: ['expectApiError', 'expectRequiredFields', 'verifyFieldExpectation'],
        },
      ],
      // Fixtures use Playwright's `use` callback, not React hooks.
      'playwright/no-standalone-expect': 'off',
      // Environment-driven skips (e.g. destructive tests in UAT) are intentional.
      'playwright/no-skipped-test': ['warn', { allowConditional: true }],
    },
  },
  {
    // Plain JS config files are not part of the TS project.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
