import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // Use relative paths for assets
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
