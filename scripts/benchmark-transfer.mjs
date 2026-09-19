// Synthetic, single-process transfer comparison. No model, TLS, or Tailcat traffic.
// node scripts/benchmark-transfer.mjs source|packed|mixed|large identity|gzip [MiB/s]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { snapshot, materialize } from '../lib/files.mjs';
import { writeMessage, readRequest, releaseReceived, encodeBody } from '../lib/transfer.mjs';

const [kind = 'source', encoding = 'identity', rateText = '0'] = process.argv.slice(2);
const rate = Number(rateText);
if (!['source', 'packed', 'mixed', 'large'].includes(kind) || !['identity', 'gzip'].includes(encoding) || !Number.isFinite(rate) || rate < 0) throw new Error('Use source|packed|mixed|large identity|gzip [MiB/s >= 0].');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-transfer-benchmark-'));
let received;
try {
  const work = path.join(root, 'work'); await fs.mkdir(work);
  const count = kind === 'large' ? 1 : 5000, size = Math.floor(50 * 1024 * 1024 / count);
  for (let i = 0; i < count; i++) {
    let content = Buffer.alloc(size);
    if (kind === 'packed' || kind === 'mixed' && i % 2) {
      let seed = i + 1;
      for (let j = 0; j < content.length; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; content[j] = seed >>> 24; }
      content = gzipSync(content);
    } else content.fill(`export const item${i} = ${i}; // synthetic project source\n`);
    const directory = path.join(work, String(Math.floor(i / 100)));
    if (i % 100 === 0) await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `${i}.bin`), content);
  }
  const started = performance.now(), cpu = process.cpuUsage();
  const copy = await snapshot(work, await fs.readdir(work), { storage: path.join(root, 'frozen') });
  const prepared = performance.now();
  let wireBytes = 0, next = performance.now();
  const wire = new Transform({ transform(chunk, _, callback) {
    wireBytes += chunk.length;
    if (!rate) { callback(null, chunk); return; }
    next = Math.max(next, performance.now()) + chunk.length / (rate * 1024 * 1024) * 1000;
    const wait = next - performance.now();
    if (wait >= 2) setTimeout(() => callback(null, chunk), wait);
    else callback(null, chunk);
  } });
  const output = encoding === 'gzip' ? encodeBody(wire) : wire;
  const reading = readRequest(wire, { streaming: true, encoding });
  const writing = writeMessage(output, { files: copy.files }).then(() => output.end(), error => { output.destroy(error); throw error; });
  [received] = await Promise.all([reading, writing]);
  const transferred = performance.now();
  await materialize(path.join(root, 'saved'), received.value.files);
  const finished = performance.now(), used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ kind, encoding, MiBPerSecond: rate, files: count, inputBytes: copy.bytes, wireBytes,
    prepareMs: Math.round(prepared - started), transferAndReceiveMs: Math.round(transferred - prepared), saveMs: Math.round(finished - transferred), totalMs: Math.round(finished - started),
    cpuMs: Math.round((used.user + used.system) / 1000), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), node: process.version, platform: `${process.platform}-${process.arch}` }));
} finally { await releaseReceived(received?.value); await fs.rm(root, { recursive: true, force: true }); }
