import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2024, sourceType: 'module' }, rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }], eqeqeq: ['error', 'smart'], 'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }], 'no-implicit-globals': 'error', 'no-shadow-restricted-names': 'error',
  } },
  { files: ['*.js', 'src/**/*.js', 'test/**/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['public/pcm-worklet.js'], languageOptions: { globals: { AudioWorkletProcessor: 'readonly', sampleRate: 'readonly', registerProcessor: 'readonly' } } },
];
