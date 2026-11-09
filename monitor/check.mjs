/**
 * IPTV 线路有效性探测
 * 用法：
 *   node monitor/check.mjs                        # 探测线上聚合列表
 *   node monitor/check.mjs --input ./list.m3u     # 探测本地文件
 *   node monitor/check.mjs --out ../out           # 指定输出目录
 * 输出：alive.m3u（只保留通过探测的线路）、status.json（每个频道的探测结果）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INPUT = 'https://itv3.940214.xyz/list.m3u?refresh=1';
const TIMEOUT_MS = 8000;
const CONCURRENCY = 24;
const MAX_BYTES = 4096; // 只读取开头，判断是不是有效播放列表

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function parseM3U(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let extinf = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) { extinf = line; continue; }
    if (line.startsWith('#')) continue;
    if (extinf) {
      const name = extinf.includes(',') ? extinf.slice(extinf.lastIndexOf(',') + 1).trim() : '';
      out.push({ name, extinf, url: line });
      extinf = null;
    }
  }
  return out;
}

async function readFirstBytes(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  let buf = '';
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    total += value.length;
  }
  try { await reader.cancel(); } catch {}
  return buf;
}

async function probe(item) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; itv-monitor/1.0)' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const status = res.status;
    let ok = false;
    let kind = 'unknown';
    if (status === 200 || status === 206) {
      const head = await readFirstBytes(res);
      if (head.includes('#EXTM3U') || head.includes('#EXTINF')) { ok = true; kind = 'hls'; }
      else if ((res.headers.get('content-type') || '').match(/video|mp2t|octet-stream/)) { ok = true; kind = 'media'; }
      else if (head.length > 0 && head.includes('<')) { ok = false; kind = 'html'; }
    }
    return { name: item.name, url: item.url, ok, httpStatus: status, kind, ms: Date.now() - started };
  } catch (e) {
    return { name: item.name, url: item.url, ok: false, httpStatus: 0, kind: 'error', error: String(e?.message || e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, worker, limit) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const input = arg('input', DEFAULT_INPUT);
  const outDir = arg('out', '.');
  const text = /^https?:\/\//.test(input)
    ? await (await fetch(input, { headers: { 'User-Agent': 'itv-monitor' } })).text()
    : await readFile(input, 'utf8');

  const items = parseM3U(text);
  console.log(`待探测条目: ${items.length}`);

  const results = await runPool(items, probe, CONCURRENCY);
  const alive = results.filter(r => r.ok);

  const aliveLines = ['#EXTM3U'];
  for (const r of alive) {
    aliveLines.push(items.find(i => i.url === r.url && i.name === r.name)?.extinf || `#EXTINF:-1,${r.name}`);
    aliveLines.push(r.url);
  }

  const status = {
    generatedAt: new Date().toISOString(),
    input,
    total: results.length,
    alive: alive.length,
    dead: results.length - alive.length,
    aliveRate: results.length ? +(alive.length / results.length * 100).toFixed(1) : 0,
    results,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'alive.m3u'), aliveLines.join('\n') + '\n', 'utf8');
  await writeFile(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  console.log(`有效 ${alive.length} / ${results.length} (${status.aliveRate}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
