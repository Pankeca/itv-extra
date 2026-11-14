// 在 GitHub Actions（Node 20）里直接执行 worker/worker.mjs 的聚合逻辑，
// 生成静态 m3u 快照，供 EdgeOne Pages 托管。
// 注意：worker/worker.mjs 由 itv-hub/worker.js 同步而来，改频道规则时两边都要更新。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cloudflare Workers 才有的 API，Node 下用空实现兜底（不做缓存，每次都现算）
if (!globalThis.caches) {
  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {},
      async delete() {
        return false;
      },
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'public');
mkdirSync(outDir, { recursive: true });

const { default: worker } = await import(resolve(root, 'worker/worker.mjs'));
const ctx = { waitUntil() {}, passThroughOnException() {} };

const targets = [
  ['/list.m3u', 'list.m3u'],
  ['/alive.m3u', 'alive.m3u'],
];

for (const [path, file] of targets) {
  const url = `https://itv3.940214.xyz${path}?refresh=1`;
  const res = await worker.fetch(new Request(url), {}, ctx);
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('#EXTM3U')) throw new Error(`${path} 内容不是合法 m3u`);
  const count = (text.match(/^#EXTINF/gm) || []).length;
  writeFileSync(resolve(outDir, file), text);
  console.log(`${file}: ${count} 条`);
}
