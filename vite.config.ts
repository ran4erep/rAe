import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {normalizeBasePath} from './src/utils/assetUrl.ts';

export default defineConfig(() => {
  return {
    base: normalizeBasePath(process.env.VITE_BASE_PATH),
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          const srcBios = path.resolve(__dirname, 'bios');
          const distBios = path.resolve(distDir, 'bios');
          if (fs.existsSync(distDir) && fs.existsSync(srcBios)) {
            fs.cpSync(srcBios, distBios, {recursive: true, force: true});
          }
          const srcWasm = path.resolve(__dirname, 'node_modules/7z-wasm/7zz.wasm');
          const distWasmDir = path.resolve(distDir, 'wasm');
          if (fs.existsSync(distDir) && fs.existsSync(srcWasm)) {
            fs.mkdirSync(distWasmDir, {recursive: true});
            fs.copyFileSync(srcWasm, path.join(distWasmDir, '7zz.wasm'));
          }
          if (fs.existsSync(distDir)) {
            fs.writeFileSync(path.join(distDir, '.nojekyll'), '');
          }
        },
      },
      {
        name: 'serve-bios-and-wasm-folders',
        configureServer(server) {
          const biosDir = path.resolve(__dirname, 'bios');
          server.middlewares.use('/bios', (req, res, next) => {
            const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
            const resolved = path.resolve(biosDir, '.' + urlPath);
            if (!resolved.startsWith(biosDir + path.sep) && resolved !== biosDir) {
              res.statusCode = 403;
              res.end('Forbidden');
              return;
            }
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
              res.setHeader('Content-Type', 'application/octet-stream');
              res.setHeader('Cache-Control', 'public, max-age=3600');
              fs.createReadStream(resolved).pipe(res);
              return;
            }
            next();
          });

          const wasmPath = path.resolve(__dirname, 'node_modules/7z-wasm/7zz.wasm');
          server.middlewares.use('/wasm/7zz.wasm', (_req, res, next) => {
            if (fs.existsSync(wasmPath)) {
              res.setHeader('Content-Type', 'application/wasm');
              res.setHeader('Cache-Control', 'public, max-age=86400');
              fs.createReadStream(wasmPath).pipe(res);
              return;
            }
            next();
          });
        },
      },
    ],
    optimizeDeps: {
      exclude: ['7z-wasm'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
