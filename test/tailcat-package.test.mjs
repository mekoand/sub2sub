import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyTailcat } from '../lib/tailcat.mjs';
import { install } from '../scripts/install.mjs';
const exec = promisify(execFile);

test('release packaging includes only the selected helper, its metadata and licenses', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-helper-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const built = path.join(root, 'built'); await fs.mkdir(path.join(built, 'licenses'), { recursive: true });
  const bytes = Buffer.from('synthetic binary for package boundary testing');
  await fs.writeFile(path.join(built, 'sub2sub-tailcat'), bytes);
  await fs.writeFile(path.join(built, 'licenses', 'LICENSE'), 'synthetic license');
  const metadata = { version: '0.6.0', platform: 'darwin', arch: 'arm64', file: 'sub2sub-tailcat', sha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(built, 'manifest.json'), JSON.stringify(metadata));
  await assert.rejects(verifyTailcat(built, { manifest: 'manifest.json', expected: { ...metadata, version: '0.5.0' }, execute: true }), /release metadata/);
  const target = path.join(root, 'sub2sub');
  await exec(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), target, '--tailcat-dir', built]);
  assert.deepEqual(await fs.readFile(path.join(target, 'bin/sub2sub-tailcat')), bytes);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, 'bin/tailcat.json'))), metadata);
  assert.equal(await fs.readFile(path.join(target, 'licenses/tailcat/LICENSE'), 'utf8'), 'synthetic license');
  await assert.rejects(fs.stat(path.join(target, 'bin/sub2sub-tailcat.exe')), { code: 'ENOENT' });
  await fs.access(path.join(target, 'docs/development/cross-network.md'));
  await assert.rejects(fs.stat(path.join(target, 'transport')), { code: 'ENOENT' });
  await fs.writeFile(path.join(built, 'sub2sub-tailcat'), 'changed');
  const other = path.join(root, 'bad/sub2sub'); await fs.mkdir(path.dirname(other));
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), other, '--tailcat-dir', built]), /checksum/);
});

test('installer rejects an incomplete helper before changing installed files or contacting a host', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-bad-helper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'); await fs.mkdir(payload);
  await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify({ version: '0.9.0', platform: process.platform, arch: process.arch, tailcat: { version: '0.6.0' } }));
  const installed = path.join(root, 'installed');
  await assert.rejects(install(payload, installed), /ENOENT/);
  await assert.rejects(fs.stat(installed), { code: 'ENOENT' });
});
