import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
export { MAX_BYTES, MAX_FILES } from './limits.mjs';

const exec = promisify(execFile);
const excludedDirs = new Set(['.git', '.codex', '.agents', '.sub2sub', '.ssh', '.aws', '.gnupg', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.cache']);
const buildDirs = new Set(['dist', 'build', 'coverage', '.next']);

export function safePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Invalid relative file path: ${JSON.stringify(name)}`);
  }
  return name;
}

export function excluded(name, { result = false } = {}) {
  return name.split('/').some(p => excludedDirs.has(p) || (!result && buildDirs.has(p)) || /^\.env(?:\.|$)/i.test(p) || /\.(pem|key|p12|pfx)$/i.test(p) || ['.npmrc', '.pypirc', '.netrc', '.DS_Store', 'id_rsa', 'id_ed25519'].includes(p));
}

export async function readJson(file) {
  const target = (await fs.lstat(file)).isDirectory() ? path.join(file, 'metadata.json') : file;
  return JSON.parse(await fs.readFile(target, 'utf8'));
}
export async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

async function readEntry(root, name, maxBytes = Infinity, storage) {
  safePath(name);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not transferred: ${name}`);
  }
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${name}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes limit: ${name}; reduce this file to a smaller size before retrying the transfer.`);
    if (storage) {
      await fs.mkdir(storage, { recursive: true, mode: 0o700 });
      const source = path.join(storage, randomUUID());
      const output = await fs.open(source, 'wx', stat.mode & 0o111 ? 0o700 : 0o600);
      const digest = createHash('sha256');
      let size = 0;
      try {
        for await (const data of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
          size += data.length;
          if (size > maxBytes) throw new Error(`File grew beyond ${maxBytes} bytes limit: ${name}`);
          digest.update(data);
          await output.writeFile(data);
        }
      } catch (error) { await output.close(); await fs.rm(source, { force: true }); throw error; }
      await output.close();
      return { path: name, source, size, hash: digest.digest('hex'), executable: Boolean(stat.mode & 0o111) };
    }
    const data = await handle.readFile();
    if (data.length > maxBytes) throw new Error(`File grew beyond ${maxBytes} bytes limit: ${name}`);
    return { path: name, content: data.toString('base64'), executable: Boolean(stat.mode & 0o111) };
  } finally { await handle.close(); }
}

async function walk(root, name, names, skipped, options) {
  if (name) safePath(name);
  if (options.temporaryFiles && name === '.sub2sub') return;
  if (excluded(name, options)) { skipped.push(name); return; }
  const stat = await fs.lstat(path.join(root, name));
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not transferred: ${name}`);
  if (stat.isDirectory()) {
    for (const child of await fs.readdir(path.join(root, name))) {
      await walk(root, name ? `${name}/${child}` : child, names, skipped, options);
    }
  } else if (stat.isFile()) {
    names.add(name);
    if (names.size > (options?.maxFiles ?? Infinity)) throw new Error(`File count exceeds ${options?.maxFiles ?? Infinity}; select a smaller set of paths.`);
  } else throw new Error(`Special files are not transferred: ${name}`);
}

export function validateFiles(files, options = {}) {
  const { maxBytes = Infinity, maxFiles = Infinity } = options;
  if (!Array.isArray(files) || files.length > maxFiles) throw new Error(`Invalid file list (maximum ${maxFiles} files).`);
  const names = new Set();
  let bytes = 0;
  for (const file of files) {
    safePath(file.path);
    if (excluded(file.path, options)) throw new Error(`Excluded file: ${file.path}`);
    if (names.has(file.path)) throw new Error(`Duplicate file: ${file.path}`);
    if (file.source !== undefined) {
      if (typeof file.source !== 'string' || !path.isAbsolute(file.source) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash) || typeof file.executable !== 'boolean' || file.content !== undefined) throw new Error(`Invalid stored file: ${file.path}`);
    } else if (typeof file.executable !== 'boolean' || typeof file.content !== 'string' || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new Error(`Invalid file content: ${file.path}`);
    names.add(file.path);
    bytes += fileSize(file);
    if (bytes > maxBytes) throw new Error(`Work copy exceeds ${maxBytes} bytes limit; adjust limits or select a smaller set of paths.`);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) throw new Error(`File/directory conflict: ${name}`);
  }
  return bytes;
}

export async function snapshot(workspace, selected, options = {}) {
  const { maxBytes = Infinity, maxFiles = Infinity } = options;
  const root = await fs.realpath(workspace);
  const names = new Set();
  const skipped = [];
  if (selected !== undefined) {
    if (!Array.isArray(selected) || (!selected.length && !options.allowEmpty) || selected.length > maxFiles) throw new Error('paths must be a non-empty array within the input file limit.');
    for (const name of selected) {
      safePath(name);
      await walk(root, name, names, skipped, options);
    }
  } else {
    const { stdout: top } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    if (await fs.realpath(top.trim()) !== root) throw new Error('Use the Git root, or supply explicit paths for a subdirectory.');
    for await (const name of trackedFiles(root)) {
      safePath(name);
      if (excluded(name, options)) { skipped.push(name); continue; }
      try { await fs.lstat(path.join(root, name)); }
      catch (e) { if (e.code === 'ENOENT') { skipped.push(`${name} (deleted locally)`); continue; } throw e; }
      names.add(name);
    }
  }
  if (!names.size && !options.allowEmpty) throw new Error('No files selected. New repositories need explicit paths.');
  if (names.size > maxFiles) throw new Error(`File count exceeds ${maxFiles}; select a smaller set of paths.`);
  const files = [];
  let bytes = 0;
  for (const name of [...names].sort()) {
    const entry = await readEntry(root, name, maxBytes - bytes, options.storage);
    bytes += fileSize(entry);
    if (bytes > maxBytes) throw new Error(`Work copy exceeds ${maxBytes} bytes limit; adjust limits or select a smaller set of paths.`);
    files.push(entry);
  }
  validateFiles(files, options);
  return { root, files, bytes, skipped };
}

export async function materialize(root, files, options) {
  validateFiles(files, options);
  await fs.mkdir(root, { recursive: false, mode: 0o700 });
  for (const file of files) {
    const destination = path.join(root, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyEntry(file, destination);
  }
}

export async function collectChanges(root, original, options = {}) {
  const { maxBytes = Infinity, maxFiles = Infinity } = options;
  const names = new Set();
  const skipped = [];
  await walk(root, '', names, skipped, { result: true, maxFiles: Infinity, temporaryFiles: options.temporaryFiles });
  const current = [], manifest = [];
  const before = new Map(original.map(f => [f.path, f]));
  let bytes = 0;
  const created = [];
  try {
    for (const name of [...names].sort()) {
      const entry = await readEntry(root, name, Infinity, options.storage);
      if (entry.source) created.push(entry.source);
      const hash = entry.hash || createHash('sha256').update(Buffer.from(entry.content, 'base64')).digest('hex');
      const prior = before.get(name);
      const priorHash = prior?.hash || (prior?.content !== undefined ? createHash('sha256').update(Buffer.from(prior.content, 'base64')).digest('hex') : undefined);
      const changed = priorHash !== hash || prior?.executable !== entry.executable;
      if (!changed && entry.source) await fs.rm(entry.source);
      if (changed) bytes += fileSize(entry);
      if (bytes > maxBytes) throw new Error(`Result exceeds ${maxBytes} bytes limit; reduce generated output before collecting.`);
      if (changed) current.push(entry);
      manifest.push({ path: name, hash, executable: entry.executable });
    }
    const changes = current;
    const removed = original.filter(f => !names.has(f.path)).map(f => f.path);
    validateFiles(changes, { result: true, maxBytes, maxFiles });
    return { files: changes, removed, skipped, manifest };
  } catch (error) {
    await Promise.all(created.map(source => fs.rm(source, { force: true })));
    throw error;
  }
}

export const fileSize = file => file.source ? file.size : Buffer.byteLength(file.content, 'base64');

export async function copyEntry(file, destination) {
  const output = await fs.open(destination, 'wx', file.executable ? 0o700 : 0o600);
  try {
    for await (const chunk of entryChunks(file)) await output.writeFile(chunk);
  } finally { await output.close(); }
}

export async function* entryChunks(file) {
  if (!file.source) {
    // Base64 boundaries must be multiples of four to decode each piece independently.
    for (let offset = 0; offset < file.content.length; offset += 256 * 1024) yield Buffer.from(file.content.slice(offset, offset + 256 * 1024), 'base64');
    return;
  }
  const handle = await fs.open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256'); let size = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Stored transfer content is not a regular file.');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      size += chunk.length;
      if (size > file.size) throw new Error(`Stored file changed: ${file.path}`);
      hash.update(chunk); yield chunk;
    }
    if (size !== file.size || hash.digest('hex') !== file.hash) throw new Error(`Stored file changed: ${file.path}`);
  } finally { await handle.close(); }
}

async function* trackedFiles(root) {
  const child = spawn('git', ['ls-files', '-z', '--cached'], { cwd: root });
  let error, stderr = '', pending = '';
  child.on('error', e => { error = e; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.setEncoding('utf8');
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\0')) !== -1) {
        const name = pending.slice(0, i); pending = pending.slice(i + 1);
        if (name) yield name;
      }
    }
    if (await closed !== 0 || error || pending) throw error || new Error(`Cannot enumerate Git files: ${stderr}`);
  } finally { if (child.exitCode === null) child.kill(); }
}
