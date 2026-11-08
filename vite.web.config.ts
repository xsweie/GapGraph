import { defineConfig } from 'vite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const runDir = process.env.GAPGRAPH_RUN_DIR
const aiOrigin = process.env.GAPGRAPH_AI_ORIGIN

function reportWebAddress() {
  return {
    name: 'gapgraph-web-address',
    configureServer(server: import('vite').ViteDevServer) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (!runDir || !address || typeof address === 'string') return
        writeFileSync(join(runDir, 'web.json'), JSON.stringify({ url: `http://localhost:${address.port}` }))
      })
    }
  }
}

/**
 * 把构建产物改成"双击就能开"的形态：
 * file:// 下 ESM 模块脚本和 crossorigin 资源都会被 CORS 拦掉，
 * 所以打成单个 IIFE，并把 script/link 标签改成普通资源引用。
 */
function fileFriendly() {
  return {
    name: 'file-friendly-build',
    closeBundle() {
      const file = resolve('out/web/index.html')
      let html = readFileSync(file, 'utf8')
      html = html
        .replace(/<script type="module" crossorigin/g, '<script defer')
        .replace(/<script type="module"/g, '<script defer')
        .replace(/\s+crossorigin(?=[\s>])/g, '')
      writeFileSync(file, html, 'utf8')
    }
  }
}

export default defineConfig({
  base: './',
  root: resolve('src/renderer'),
  plugins: [fileFriendly(), ...(runDir ? [reportWebAddress()] : [])],
  server: {
    port: 5180,
    open: !runDir,
    fs: {
      allow: [resolve('.')],
      deny: ['.env', '.env.*', '*.{crt,pem,key,dpapi}', '.credentials.yaml', '**/.git/**', '**/.data/**']
    },
    proxy: runDir && aiOrigin ? {
      '^/(health|scope|chat|pack|questions|explain)(\\?|$)': aiOrigin
    } : undefined
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } }
  }
})
