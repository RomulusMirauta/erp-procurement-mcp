import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Tests read tool results as parsed JSON and assert on their shape.
  { files: ['tests/**'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
