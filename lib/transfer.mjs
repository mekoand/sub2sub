import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { entryChunks, fileSize, validateFiles } from './files.mjs';

export const STREAM_TYPE = 'application/x-sub2sub-stream';
const FRAME_BYTES = 1024 * 1024;
const RECEIVED = Symbol('received transfer storage');

export function decodeBody(input, encoding) {
  if (!encoding || encoding === 'identity') return input;
  if (encoding !== 'gzip') throw new Error(`Unsupported transfer encoding: ${encoding}`);
  const decoder = createGunzip();
  const failed = error => decoder.destroy(error);
  const aborted = () => failed(new Error('Compressed transfer interrupted.'));
  input.once('error', failed); input.once('aborted', aborted);
  decoder.once('close', () => {
    input.unpipe(decoder); input.off('error', failed); input.off('aborted', aborted);
  });
  return input.pipe(decoder);
}

export function encodeBody(output) {
  const encoder = createGzip({ level: 1 });
  encoder.on('error', error => output.destroy(error));
  output.once('close', () => encoder.destroy());
  encoder.pipe(output);
  return encoder;
}

// One bounded JSON record per structural token or file chunk. File paths on the
// sender's disk never cross the wire; the receiver creates its own private files.
export async function writeMessage(output, value) {
  const record = async token => {
    const line = JSON.stringify(token) + '\n';
    if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error('Transfer metadata record is too large.');
    if (output.destroyed) throw new Error('Transfer connection closed.');
    if (!output.write(line)) await new Promise((resolve, reject) => {
      const done = error => {
        output.off('drain', drained); output.off('close', closed); output.off('error', done);
        if (error) reject(error); else resolve();
      };
      const drained = () => done(), closed = () => done(new Error('Transfer connection closed.'));
      output.once('drain', drained); output.once('close', closed); output.once('error', done);
      if (output.destroyed) closed();
    });
  };
  const visit = async (item, depth = 0) => {
    if (depth > 64) throw new Error('Transfer metadata is too deeply nested.');
    if (item && typeof item === 'object' && Object.hasOwn(item, 'path') && (Object.hasOwn(item, 'source') || Object.hasOwn(item, 'content'))) {
      validateFiles([item], { result: true });
      let hash = item.hash;
      if (!item.source) {
        const digest = createHash('sha256');
        for await (const chunk of entryChunks(item)) digest.update(chunk);
        hash = digest.digest('hex');
      }
      await record(['file', { path: item.path, size: fileSize(item), hash, executable: item.executable }]);
      for await (const chunk of entryChunks(item)) await record(['chunk', chunk.toString('base64')]);
      await record(['fileEnd']);
    } else if (Array.isArray(item)) {
      await record(['array']);
      for (const child of item) await visit(child, depth + 1);
      await record(['end']);
    } else if (item && typeof item === 'object') {
      await record(['object']);
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        await record(['key', key]); await visit(child, depth + 1);
      }
      await record(['end']);
    } else await record(['value', item ?? null]);
  };
  await record(['message']); await visit(value); await record(['messageEnd']);
}

export async function* readMessages(input, { maxBytes = Infinity, maxFiles = Infinity } = {}) {
  let buffer = '', stack = [], message, started = false, assigned = false, storage, file, handle, hash, fileBytes = 0, bytes = 0, count = 0;
  const add = value => {
    if (!stack.length) {
      if (assigned) throw new Error('Multiple transfer roots.');
      message = value; assigned = true; return;
    }
    const top = stack.at(-1);
    if (Array.isArray(top.value)) top.value.push(value);
    else {
      if (top.key === undefined || Object.hasOwn(top.value, top.key)) throw new Error('Missing or duplicate transfer key.');
      Object.defineProperty(top.value, top.key, { value, enumerable: true, writable: true, configurable: true });
      top.key = undefined;
    }
  };
  try {
    input.setEncoding('utf8');
    for await (const chunk of input) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error('Transfer record is too large.');
        const token = JSON.parse(line);
        if (!Array.isArray(token)) throw new Error('Invalid transfer record.');
        const [type, value] = token;
        if (type === 'message') {
          if (started || token.length !== 1) throw new Error('Unexpected transfer message.');
          started = true; assigned = false; bytes = 0; count = 0;
        } else {
          if (!started) throw new Error('Missing transfer message header.');
          if (file && !['chunk', 'fileEnd'].includes(type)) throw new Error('Incomplete transfer file.');
          if (type === 'object' || type === 'array') {
            if (stack.length >= 64) throw new Error('Transfer metadata is too deeply nested.');
            const child = type === 'array' ? [] : {};
            add(child); stack.push({ value: child });
          } else if (type === 'key') {
            const top = stack.at(-1);
            if (!top || Array.isArray(top.value) || top.key !== undefined || typeof value !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid transfer key.');
            top.key = value;
          } else if (type === 'value') {
            if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw new Error('Invalid transfer value.');
            add(value);
          } else if (type === 'end') {
            if (!stack.length || stack.at(-1).key !== undefined) throw new Error('Incomplete transfer object.');
            const ending = stack.pop().value;
            if (Object.hasOwn(ending, 'source') && Object.hasOwn(ending, 'path')) throw new Error('Remote file references are forbidden.');
          } else if (type === 'file') {
            if (!value || Object.keys(value).some(k => !['path', 'size', 'hash', 'executable'].includes(k))) throw new Error('Invalid file header.');
            count++; bytes += value.size;
            if (count > maxFiles || bytes > maxBytes) throw new Error('Transfer exceeds the receiving file count or byte limit.');
            storage ||= await fs.mkdtemp(path.join(os.tmpdir(), 'sub2sub-receive-'));
            file = { ...value, source: path.join(storage, randomUUID()) };
            validateFiles([file], { result: true });
            handle = await fs.open(file.source, 'wx', 0o600); hash = createHash('sha256'); fileBytes = 0;
          } else if (type === 'chunk') {
            if (!file || typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid transfer chunk.');
            const data = Buffer.from(value, 'base64'); fileBytes += data.length;
            if (fileBytes > file.size) throw new Error('Transfer file exceeds its declared size.');
            hash.update(data); await handle.writeFile(data);
          } else if (type === 'fileEnd') {
            if (!file || fileBytes !== file.size || hash.digest('hex') !== file.hash) throw new Error('Incomplete or corrupt transfer file.');
            await handle.close(); handle = undefined; add(file); file = undefined;
          } else if (type === 'messageEnd') {
            if (stack.length || !assigned || !message || typeof message !== 'object') throw new Error('Incomplete transfer message.');
            if (storage) Object.defineProperty(message, RECEIVED, { value: storage });
            // Ownership passes to the caller, which releases it after saving.
            const result = message; storage = undefined; message = undefined; started = false;
            yield result;
          } else throw new Error('Unknown transfer record.');
        }
      }
      if (Buffer.byteLength(buffer) > FRAME_BYTES) throw new Error('Transfer record is too large.');
    }
    if (buffer || started || file) throw new Error('Incomplete transfer stream.');
  } finally {
    await handle?.close();
    if (storage) await fs.rm(storage, { recursive: true, force: true });
  }
}

export function retainReceived(wrapper, result) {
  if (wrapper[RECEIVED]) Object.defineProperty(result, RECEIVED, { value: wrapper[RECEIVED] });
  return result;
}
export async function releaseReceived(value) {
  if (value?.[RECEIVED]) await fs.rm(value[RECEIVED], { recursive: true, force: true });
}

// Legacy JSON must not be allowed to name a file on this machine.
export function parseLegacy(text) {
  return JSON.parse(text, (key, value) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || value && typeof value === 'object' && Object.hasOwn(value, 'source') && Object.hasOwn(value, 'path')) throw new Error('Invalid legacy transfer key.');
    return value;
  });
}

export async function legacyMessage(value) {
  let bytes = 0, count = 0;
  const visit = async item => {
    if (item && typeof item === 'object' && Object.hasOwn(item, 'path') && (Object.hasOwn(item, 'source') || Object.hasOwn(item, 'content'))) {
      bytes += fileSize(item); count++;
      if (bytes > 64 * 1024 * 1024 || count > 10000) throw new Error('The older node supports at most 64 MiB / 10,000 files. Upgrade both nodes before transferring this work.');
      if (!item.source) return item;
      const chunks = [];
      for await (const chunk of entryChunks(item)) chunks.push(chunk);
      return { path: item.path, content: Buffer.concat(chunks).toString('base64'), executable: item.executable };
    }
    if (Array.isArray(item)) { const result = []; for (const child of item) result.push(await visit(child)); return result; }
    if (item && typeof item === 'object') { const result = {}; for (const [key, child] of Object.entries(item)) result[key] = await visit(child); return result; }
    return item;
  };
  return visit(value);
}

export async function readRequest(input, options = {}) {
  const { Readable } = await import('node:stream');
  input = decodeBody(input, options.encoding);
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  const rest = Readable.from((async function* () {
    try {
      if (!first.done) yield first.value;
      for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; }
    } finally { await iterator.return?.(); }
  })());
  let value;
  const streaming = !first.done && first.value.toString().startsWith('[');
  if (options.streaming !== undefined && streaming !== options.streaming) {
    await iterator.return?.();
    throw new Error('Unexpected transfer protocol.');
  }
  if (streaming) {
    try {
      for await (const message of readMessages(rest, options)) {
        if (value) { await releaseReceived(message); throw new Error('Only one request is allowed.'); }
        value = message;
      }
      if (!value) throw new Error('Empty transfer request.');
    } catch (error) { await releaseReceived(value); throw error; }
  } else {
    rest.setEncoding('utf8');
    let text = '', bytes = 0;
    for await (const chunk of rest) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.legacyBytes ?? 132 * 1024 * 1024)) throw new Error('Legacy request is too large. Upgrade both nodes.');
      text += chunk;
    }
    value = parseLegacy(text);
  }
  return { value, streaming };
}
