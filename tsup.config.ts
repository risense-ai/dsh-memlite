import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  // cordis/schemastery 必须 external：宿主校验 Config 是原生 Schemastery 实例（isNativeConfigSchema），
  // 内联副本会判 "unsupported" 拒激活；二者由 pnpm 从插件依赖装入 profile。
  external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
})
