import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The helper reports a single versioned JSON record. Its diagnostics never enter the protocol.
export async function startTailcat(mode, target, port = 0) {
  const executable = process.env.SUB2SUB_TAILCAT || fileURLToPath(new URL(`../bin/sub2sub-tailcat${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  const child = spawn(executable, mode === 'serve' ? [mode, target, String(port)] : [mode, target], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let diagnostics = '', output = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.stdin.on('error', () => {}); // The exit/error event reports helper failure.
  const exited = new Promise(resolve => child.once('close', resolve));
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
    await exited; clearTimeout(timer);
  };
  try {
    const result = await new Promise((resolve, reject) => {
      const finish = (error, result) => { clearTimeout(timer); child.stdout.removeListener('data', data); child.removeListener('close', failed); child.removeListener('error', fail); error ? reject(error) : resolve(result); };
      const fail = error => finish(new Error(`Cross-network helper unavailable: ${error.message}`, { cause: error }));
      const failed = code => finish(new Error(`Cross-network helper exited (${code}): ${diagnostics}`));
      const data = chunk => {
        output += chunk;
        if (output.length > 8192) { finish(new Error('Invalid cross-network helper response.')); return; }
        if (!output.includes('\n')) return;
        try {
          const result = JSON.parse(output.trim());
          if (result.protocol !== 1 || (mode === 'serve' ? typeof result.address !== 'string' || !result.address || result.address.length > 4096 : !Number.isInteger(result.port) || result.port < 1 || result.port > 65535)) throw new Error('Invalid cross-network helper response.');
          finish(undefined, result);
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('Cross-network helper startup timed out. Check relay reachability.')), 35000);
      child.once('error', fail); child.once('close', failed); child.stdout.on('data', data);
    });
    return { ...result, close, exited, get diagnostics() { return diagnostics.trim(); }, get alive() { return child.exitCode === null && child.signalCode === null && !child.killed; } };
  } catch (error) { await close(); throw error; }
}

// Verify release bytes before installation. The optional execution is offline and creates no identity.
export async function verifyTailcat(directory, { manifest = 'tailcat.json', platform, arch, expected, execute = false } = {}) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, manifest), 'utf8'));
  const file = metadata.platform === 'win32' ? 'sub2sub-tailcat.exe' : 'sub2sub-tailcat';
  if (!['darwin', 'win32', 'linux'].includes(metadata.platform) || !['arm64', 'x64'].includes(metadata.arch) || metadata.file !== file || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid Tailcat package metadata.');
  if ((platform && metadata.platform !== platform) || (arch && metadata.arch !== arch)) throw new Error('Tailcat package platform does not match this device.');
  if (expected && ['sha256', 'version', 'platform', 'arch', 'file'].some(key => metadata[key] !== expected[key])) throw new Error('Tailcat release metadata does not match the packaged helper.');
  const executable = path.join(directory, file);
  if (createHash('sha256').update(await fs.readFile(executable)).digest('hex') !== metadata.sha256) throw new Error('Tailcat package checksum mismatch.');
  if (execute) {
    const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 10000, windowsHide: true });
    const result = JSON.parse(stdout);
    if (result.protocol !== 1 || result.version !== metadata.version || result.platform !== metadata.platform || result.arch !== metadata.arch) throw new Error('Tailcat executable version does not match its package.');
  }
  return metadata;
}
