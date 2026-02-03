import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    base: './', // Use relative paths for assets
    plugins: [
        nodePolyfills({
            // Whether to polyfill `node:` protocol imports.
            protocolImports: true,
        }),
    ],
    server: {
        proxy: {
            '/rtmsAPI': {
                target: 'https://ccbootcampsandboxccbcamp1023wbxai-usor.us.webexconnect.io',
                changeOrigin: true,
                secure: false,
            },

        }
    },
    preview: {
        proxy: {
            '/rtmsAPI': {
                target: 'https://ccbootcampsandboxccbcamp1023wbxai-usor.us.webexconnect.io',
                changeOrigin: true,
                secure: false,
            },

        }
    }
});
