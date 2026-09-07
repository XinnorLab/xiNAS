import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const appRoot = resolve(import.meta.dirname, 'src/mcp-apps');

export default defineConfig({
  root: appRoot,
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/mcp-apps'),
    emptyOutDir: true,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: resolve(appRoot, 'raid-create.html'),
      output: {
        entryFileNames: 'raid-create.js',
        assetFileNames: 'raid-create.[ext]',
      },
    },
  },
});
