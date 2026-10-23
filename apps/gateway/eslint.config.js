import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.workspace/**'] },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // `_name` marks a deliberately unused binding (e.g. a prop dropped by destructuring).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  }
);
