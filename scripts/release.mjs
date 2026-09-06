import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] || 'dist');
const nodeVersion = '24.20.0';
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
if (process.platform === 'win32') throw new Error('Build release archives on macOS or Linux (tar, zip and unzip required).');
const download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
await fs.mkdir(output, { recursive: true });
const checksums = (await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).toString();
const sums = [];
for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-release-'));
  try {
    const extension = platform === 'win32' ? 'zip' : 'tar.gz';
    const nodeName = `node-v${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`;
    const archive = `${nodeName}.${extension}`;
    const bytes = await download(`https://nodejs.org/dist/v${nodeVersion}/${archive}`);
    const expected = checksums.split('\n').find(line => line.trim().split(/\s+/)[1] === archive)?.split(/\s+/)[0];
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Node checksum mismatch: ${archive}`);
    await fs.writeFile(path.join(temporary, archive), bytes);
    if (extension === 'zip') await exec('unzip', ['-q', path.join(temporary, archive), '-d', temporary]);
    else await exec('tar', ['-xzf', path.join(temporary, archive), '-C', temporary]);
    const payload = path.join(temporary, 'payload');
    await fs.mkdir(path.join(payload, 'plugins'), { recursive: true });
    await exec(process.execPath, [path.join(root, 'scripts/package.mjs'), path.join(payload, 'plugins/sub2sub')]);
    const binary = platform === 'win32' ? 'node.exe' : 'bin/node';
    await fs.mkdir(path.dirname(path.join(payload, 'runtime', binary)), { recursive: true });
    await fs.copyFile(path.join(temporary, nodeName, binary), path.join(payload, 'runtime', binary));
    await fs.chmod(path.join(payload, 'runtime', binary), 0o755);
    await fs.copyFile(path.join(temporary, nodeName, 'LICENSE'), path.join(payload, 'runtime/LICENSE'));
    await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify({ version, platform, arch, nodeVersion }, null, 2) + '\n');
    const asset = `sub2sub-${platform}-${arch}.${extension}`;
    const destination = path.join(output, asset);
    await fs.rm(destination, { force: true });
    if (extension === 'zip') await exec('zip', ['-qr', destination, '.'], { cwd: payload });
    else await exec('tar', ['-czf', destination, '-C', payload, '.']);
    sums.push(`${createHash('sha256').update(await fs.readFile(destination)).digest('hex')}  ${asset}`);
    console.log(`${asset}: ${Math.round((await fs.stat(destination)).size / 1024 / 1024)} MiB`);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
for (const name of ['install.sh', 'install.ps1']) await fs.copyFile(path.join(root, name), path.join(output, name));
await fs.writeFile(path.join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
