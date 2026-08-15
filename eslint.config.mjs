import eslintConfig from '@electron-toolkit/eslint-config'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'

export default [
    // `indent` is a RULE, so it has to sit under `rules`. As a bare top-level key it made
    // ESLint 10 reject the whole config with "Unexpected key indent found", which took the
    // lint script out entirely rather than just skipping the rule.
    {
        rules: {
            indent: ['error', 4]
        }
    },
    { ignores: ['**/node_modules', '**/dist', '**/out', '**/docs', '**/test-keystores'] },
    eslintConfig,
    ...eslintPluginVue.configs['flat/recommended'],
    {
        files: ['**/*.{js,jsx,vue}'],
        rules: {
            'vue/require-default-prop': 'off',
            'vue/multi-word-component-names': 'off'
        }
    },
    eslintConfigPrettier
]
