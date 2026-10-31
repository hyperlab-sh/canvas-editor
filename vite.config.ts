import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The `/*` block of public/_headers (what Cloudflare sends): dev and preview send it too, so every e2e
// test runs under the production CSP. The deployed policy once blocked icons nobody saw in dev.
const deployedHeaders = Object.fromEntries(
  readFileSync(path.resolve(__dirname, 'public/_headers'), 'utf8').split(/\n(?=\S)/)[0]!.split('\n').slice(1)
    .map((line) => line.trim()).filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);

// The prod policy has no 'unsafe-inline', but the dev server's index.html gets plugin-react's inline
// Fast Refresh preamble: allow exactly that script by hash, so dev and e2e still enforce the rest.
const preambleHash = createHash('sha256').update(react.preambleCode.replace('__BASE__', '/')).digest('base64');
deployedHeaders['Content-Security-Policy'] = deployedHeaders['Content-Security-Policy']!.replace("script-src 'self'", `script-src 'self' 'sha256-${preambleHash}'`);

// Only the version reaches the bundle (usage beacons report it); importing package.json would ship all of it.
const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// The Custom provider's same-origin proxy, as nginx/ai-proxy.sh sets it up in the Docker image: only when
// OPENFLOWKIT_AI_UPSTREAM is set, only the model list and chat, without the browser's Origin or cookies.
const aiUpstream = process.env.OPENFLOWKIT_AI_UPSTREAM?.replace(/\/+$/, '');
const aiProxy: Record<string, ProxyOptions> = aiUpstream ? {
  '^/ai-proxy/(models|chat/completions)(\\?.*)?$': {
    target: aiUpstream, changeOrigin: true, rewrite: (url) => url.replace(/^\/ai-proxy/, ''),
    configure: (proxy) => proxy.on('proxyReq', (request) => { for (const name of ['origin', 'referer', 'cookie']) request.removeHeader(name); }),
  },
} : {};

export default defineConfig(() => {
  return {
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    server: {
      port: 3000,
      host: '0.0.0.0',
      headers: deployedHeaders,
      proxy: aiProxy,
    },
    preview: { headers: deployedHeaders, proxy: aiProxy },
    plugins: [react()],
    // Workers are not in the dev server's startup scan: their deps (gifenc, mediabunny) were found on the
    // first encode, and Vite reloaded every open page mid-session (CI's motion-dialog flake).
    optimizeDeps: { entries: ['index.html', 'src/**/*.worker.ts'] },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    base: './',
    build: {
      chunkSizeWarningLimit: 900,
      modulePreload: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Collapse the per-SVG `?url` lazy stubs (1600+ icons) into a small
            // number of bucketed chunks, one per provider pack. Without this,
            // Vite emits one tiny JS module per icon and Cloudflare Pages
            // upload chokes on the file count.
            if (id.includes('/assets/third-party-icons/') && id.includes('.svg')) {
              const match = id.match(/assets\/third-party-icons\/([^/]+)\//);
              return match ? `icon-urls-${match[1]}` : 'icon-urls';
            }

            if (!id.includes('node_modules')) {
              return undefined;
            }

            if (id.includes('/node_modules/elkjs/')) {
              // Split the in-process fallback (elk.bundled) from the worker-mode API
              // so production loads only the small api shim; the bundled engine is
              // fetched only when the worker path is unavailable.
              if (id.includes('elk.bundled')) return 'vendor-elk-bundled';
              return 'vendor-elk';
            }

            return undefined;
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './vitest.setup.ts',
      testTimeout: 10000,
      maxWorkers: 2,
      // scripts/** uses node:test and mcp-server/** has its own vitest run.
      exclude: [
        'e2e/**',
        'scripts/**',
        '**/node_modules/**',
        'dist/**',
        'mcp-server/**',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/i18n/**'],
      },
    },
  };
});
