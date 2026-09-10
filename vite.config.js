import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // file:// でも動くよう相対パス出力にする
  base: './',
  server: {
    host: true,
    open: true,
    /**
     * 開発中の /api/* を wrangler dev (:8787) に転がす (DESIGN_SERVER.md §10)
     *
     * ■ なぜ @cloudflare/vite-plugin を使わないのか
     *   試したところ、プラグインは出力を dist/client と dist/<worker名> に
     *   組み替える。そうすると
     *     - wrangler.jsonc の assets.directory ("./dist") が合わなくなる
     *     - GitHub Pages へのフォールバック (dist をそのまま上げる) が壊れる
     *     - 「載せ替えて今より悪くなっていないこと」の確認 (§12 フェーズ1) が
     *       ビルド構造の変化とまざって分かりにくくなる
     *   プロキシなら **`vite build` の出力が今日とまったく同じ**ままで、
     *   ブラウザから見て同一オリジンになるので Cookie もそのまま通る。
     *   代わりに開発時は2プロセス要る (`npm run dev` と `npm run dev:api`)。
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,   // Origin を書き換えない。sameOrigin の検証を素通しにしない
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
