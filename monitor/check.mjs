/**
 * IPTV 线路有效性探测
 * 用法：
 *   node monitor/check.mjs                        # 探测全部候选源（去重后逐条探测）
 *   node monitor/check.mjs --input ./list.m3u     # 探测本地文件
 *   node monitor/check.mjs --input a.m3u,b.m3u    # 探测多个文件/URL（逗号分隔）
 *   node monitor/check.mjs --out ../out           # 指定输出目录
 * 输出：alive.m3u（只保留通过探测的线路）、status.json（每条线路的探测结果）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// 与 Worker 的源保持一致：必须覆盖“同一频道有多条候选线路”的所有上游，
// Worker 才能在同一频道里挑出真正存活的线路（否则只测到已选中的那一条）。
const DEFAULT_INPUTS = [
  'https://itv2.940214.xyz/tv9402/interface.m3u',
  './extra.m3u', // 仓库内文件，避免 raw.githubusercontent 在部分网络下不可达
  'https://itv.940214.xyz/result.m3u',
  'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u',
  'https://iptv-org.github.io/iptv/countries/cn.m3u',
  'https://iptv-org.github.io/iptv/countries/hk.m3u',
  'https://iptv-org.github.io/iptv/countries/tw.m3u',
  'https://iptv-org.github.io/iptv/countries/mo.m3u',
];
const TIMEOUT_MS = 8000;
const CONCURRENCY = 24;
const MAX_BYTES = 4096; // 只读取开头，判断是不是有效播放列表

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function loadText(input) {
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input, { headers: { 'User-Agent': 'itv-monitor' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${input}`);
    return res.text();
  }
  return readFile(input, 'utf8');
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
  const inputArg = arg('input', null);
  const inputs = inputArg
    ? inputArg.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_INPUTS;
  const outDir = arg('out', '.');

  const items = [];
  const seenUrl = new Set();
  for (const input of inputs) {
    try {
      const text = await loadText(input);
      for (const it of parseM3U(text)) {
        if (!/^https?:\/\//.test(it.url) || seenUrl.has(it.url)) continue;
        seenUrl.add(it.url);
        items.push(it);
      }
    } catch (e) {
      console.warn(`跳过 ${input}: ${e.message}`);
    }
  }
  console.log(`待探测条目: ${items.length}（源 ${inputs.length} 个，已按 URL 去重）`);

  const results = await runPool(items, probe, CONCURRENCY);
  let merged = results;

  // 部分源（如手机隧道）在境外机房会被 403，本次没测到的线路沿用上次结果，
  // 避免一次抓取不全就把稳定的存活线路全部丢掉。
  const mergePath = arg('merge', null);
  if (mergePath) {
    try {
      const prev = JSON.parse(await readFile(mergePath, 'utf8'));
      const probed = new Set(results.map(r => r.url));
      const carried = (prev.results || [])
        .filter(r => !probed.has(r.url))
        .map(r => ({ ...r, stale: true }));
      merged = results.concat(carried);
      console.log(`沿用上次结果: ${carried.length} 条`);
    } catch (e) {
      console.warn(`未读取上次结果 ${mergePath}: ${e.message}`);
    }
  }

  const alive = merged.filter(r => r.ok);

  const aliveLines = ['#EXTM3U'];
  for (const r of alive) {
    const extinf = items.find(i => i.url === r.url && i.name === r.name)?.extinf || `#EXTINF:-1,${r.name}`;
    aliveLines.push(extinf);
    aliveLines.push(r.url);
  }

  const status = {
    generatedAt: new Date().toISOString(),
    inputs,
    total: merged.length,
    alive: alive.length,
    dead: merged.length - alive.length,
    aliveRate: merged.length ? +(alive.length / merged.length * 100).toFixed(1) : 0,
    results: merged,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'alive.m3u'), aliveLines.join('\n') + '\n', 'utf8');
  await writeFile(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  console.log(`有效 ${alive.length} / ${merged.length} (${status.aliveRate}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
