import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        proxy: {
            '/rtmsAPI': {
                target: 'https://ccbootcampsandboxccbcamp1023wbxai-usor.us.webexconnect.io',
                changeOrigin: true,
                secure: false,
            }
        }
    },
    preview: {
        proxy: {
            '/rtmsAPI': {
                target: 'https://ccbootcampsandboxccbcamp1023wbxai-usor.us.webexconnect.io',
                changeOrigin: true,
                secure: false,
            }
        }
    }
});
