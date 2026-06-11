module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2022: true,
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true,
        },
    },
    plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],
    rules: {
        'no-control-regex': 'off',
        'no-mixed-spaces-and-tabs': 'off',
        'prefer-const': 'off',
        'no-case-declarations': 'off',
        'no-empty': 'off',
        'no-useless-escape': 'off',
        'no-extra-semi': 'off',
        'no-constant-condition': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        'react-hooks/exhaustive-deps': 'off',
        'react-refresh/only-export-components': 'off',
    },
    ignorePatterns: ['dist', 'dist-electron', 'release*', 'output', 'node_modules'],
}
