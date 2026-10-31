import { resolve } from 'path';
import { defineConfig } from 'vite';

// Bundles the pure agent action registry for the MCP server (Node, no DOM).
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  publicDir: false,
  build: {
    lib: { entry: resolve(__dirname, 'src/agent/index.ts'), fileName: () => 'openflowkit-agent.js', formats: ['es'] },
    outDir: 'mcp-server/src/generated',
    emptyOutDir: true,
    rollupOptions: { external: ['zod', /^elkjs\//] },
  },
});
