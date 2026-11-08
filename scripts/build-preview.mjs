/** 构建本地 UI 预览（不属于 npm 产物）。 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(root, 'preview', 'dist')
mkdirSync(outdir, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'preview', 'memory-preview.tsx')],
  outfile: path.join(outdir, 'preview.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info',
})

writeFileSync(
  path.join(root, 'preview', 'index.html'),
  `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>dsh-memlite UI preview</title>
  <style>
    html, body { margin: 0; background: #f3f0ea; color: #2b2a27; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { display: flex; justify-content: center; padding: 16px; }
    #root { width: 400px; max-width: 100%; border: 1px solid #e5e0d6; border-radius: 12px; background: #fff; min-height: 640px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./dist/preview.js"></script>
</body>
</html>
`,
)
console.log('[preview] http://127.0.0.1:8123/')
