import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));
const polyfillShimsRoot = resolve(appRoot, 'node_modules/vite-plugin-node-polyfills/shims');

// https://vite.dev/config/
export default defineConfig({
    envPrefix: ['VITE_', 'DEBUG', 'STATUS_LOG'],
    plugins: [
        react(),
        nodePolyfills({
            include: ['buffer', 'process', 'crypto', 'stream'],
        }),
    ],
    resolve: {
        alias: {
            'vite-plugin-node-polyfills/shims/buffer': resolve(polyfillShimsRoot, 'buffer'),
            'vite-plugin-node-polyfills/shims/global': resolve(polyfillShimsRoot, 'global'),
            'vite-plugin-node-polyfills/shims/process': resolve(polyfillShimsRoot, 'process'),
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: './src/setupTests.ts',
        globals: true,
    },
});
