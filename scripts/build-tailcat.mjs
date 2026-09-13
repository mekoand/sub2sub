import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../transport/tailcat', import.meta.url));
export async function buildTailcat(destination, platform, arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Tailcat build target.');
  const env = { ...process.env, GOOS: platform === 'win32' ? 'windows' : platform, GOARCH: arch === 'x64' ? 'amd64' : arch, CGO_ENABLED: '0' };
  const go = async args => (await exec(process.env.GO || 'go', args, { cwd: source, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const version = (await go(['list', '-m', '-f', '{{.Version}}', 'github.com/tailscale/tailcat'])).replace(/^v/, '');
  const file = platform === 'win32' ? 'sub2sub-tailcat.exe' : 'sub2sub-tailcat';
  await fs.mkdir(destination, { recursive: false });
  await go(['build', '-trimpath', '-ldflags', `-s -w -X main.tailcatVersion=${version}`, '-o', path.join(destination, file), '.']);
  const licenses = path.join(destination, 'licenses'); await fs.mkdir(licenses);
  const modules = [...new Set((await go(['list', '-deps', '-f', '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}', '.'])).split('\n').filter(Boolean))];
  const records = [];
  for (const line of modules) {
    const [name, version, directory] = line.split('|');
    const files = [];
    async function collect(folder, relative = '') {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) await collect(path.join(folder, entry.name), next);
        else if (entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS|AUTHORS|COPYRIGHT)(?:[-.][\w.-]+)?$/i.test(entry.name) && !/\.(go|js|ts|py)$/i.test(entry.name)) {
          const target = path.join(licenses, name, next);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(folder, entry.name), target); files.push(next.split(path.sep).join('/'));
        }
      }
    }
    await collect(directory);
    if (!files.some(f => /^(LICENSE|LICENCE|COPYING)/i.test(f))) throw new Error(`No license found for ${name}.`);
    records.push({ module: name, version, files });
  }
  const goroot = await go(['env', 'GOROOT']);
  await fs.copyFile(path.join(goroot, 'LICENSE'), path.join(licenses, 'GO-LICENSE'));
  await fs.writeFile(path.join(licenses, 'modules.json'), JSON.stringify(records, null, 2) + '\n');
  const metadata = { version, platform, arch, file, sha256: createHash('sha256').update(await fs.readFile(path.join(destination, file))).digest('hex'), goVersion: await go(['env', 'GOVERSION']) };
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/build-tailcat.mjs <new-directory> [platform] [arch]');
  console.log(JSON.stringify(await buildTailcat(path.resolve(process.argv[2]), process.argv[3] || process.platform, process.argv[4] || process.arch)));
}
