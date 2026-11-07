/**
 * 把浏览器半区打成 DSH client-modules 的 bundle 形状。
 *
 * DSH 加载器读取 package.json `dsh.client` 后，请求 `/plugins/<pkg>/client`；
 * 该文件必须调用 `window.__ModuleLoader__.load({ id, factory })`，factory 内是
 * 惰性执行的 CJS 模块体，`require` 由平台共享模块表提供（react、react/jsx-runtime）。
 * esbuild 先产出普通 CJS，这里再套上 factory 外壳，并去掉顶层 "use strict"
 * （它必须位于 factory 函数体的最前面才是指令）。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = path.join(root, '.client-build')
const compiled = path.join(temp, 'index.cjs')
const output = path.join(root, 'dist', 'client.js')

mkdirSync(temp, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src/client/index.tsx')],
  outfile: compiled,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'info',
  external: ['react', 'react/jsx-runtime'],
})

let body = readFileSync(compiled, 'utf8').replace(/^\uFEFF/, '')
body = body.replace(/^"use strict";\s*/, '')

const banner = [
  'window.__ModuleLoader__.load({',
  '\tid: "@rsrsai/dsh-memlite",',
  '\tfactory: (require) => {',
  '\t\t"use strict";',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '\t\t',
].join('\n')

const footer = [
  '\t\t',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, `${banner}${body}${footer}`, 'utf8')
rmSync(temp, { recursive: true, force: true })

console.log(`[memlite] client bundle → ${path.relative(root, output)}`)
