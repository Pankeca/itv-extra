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

// 防线：源被墙 / 大面积不可达时，条数会明显低于正常值（正常约 1651 / 1492）。
// 低于阈值直接失败退出，避免把残缺快照提交上去覆盖线上。
const MIN_ENTRIES = { 'list.m3u': 1200, 'alive.m3u': 900 };

for (const [path, file] of targets) {
  const url = `https://itv3.940214.xyz${path}?refresh=1`;
  const res = await worker.fetch(new Request(url), {}, ctx);
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('#EXTM3U')) throw new Error(`${path} 内容不是合法 m3u`);
  const count = (text.match(/^#EXTINF/gm) || []).length;
  const min = MIN_ENTRIES[file];
  if (min && count < min) {
    throw new Error(`${file} 只有 ${count} 条（低于阈值 ${min}），疑似部分源不可达，已中止以免覆盖线上快照`);
  }
  writeFileSync(resolve(outDir, file), text);
  console.log(`${file}: ${count} 条`);
}
