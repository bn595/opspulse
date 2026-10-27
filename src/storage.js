'use strict';
// Where opspulse keeps state between restarts (the snapshot cache, acknowledgements). Configured as a
// list of backends: none (memory only), one, or several. Writes go to every backend; reads come from
// the first backend that has the document. A failing backend is logged and skipped.
//
// A backend stores JSON documents by key:
//   { name?, async get(key) -> value | null, async set(key, value), async delete(key) }
// Built-in: { type: 'file', dir }. Custom: { type: 'module', path, ...options }, where the module
// exports createStorage(options, { log, request }) returning a backend. `request` is opspulse's HTTP
// client (proxies, CA, rate limits), using the network.proxies.azure proxy unless given a platform.

const fs = require('fs');
const path = require('path');
const http = require('./http');

const KEY = /^[a-z0-9][a-z0-9-]*$/i;
const CHECK_KEY = 'opspulse-check';
let written = 0; // numbers temporary files across every file backend in this process

function fileBackend(dir) {
  const fileFor = (key) => path.join(dir, `${key}.json`);
  const pending = new Map(); // key -> last write, so writes of one document land in order
  return {
    async get(key) {
      try {
        return JSON.parse(await fs.promises.readFile(fileFor(key), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    set(key, value) {
      const write = (pending.get(key) || Promise.resolve()).then(async () => {
        await fs.promises.mkdir(dir, { recursive: true });
        // Write then rename, so a crash never leaves a half-written document. The temporary name is
        // unique, so another process writing the same document cannot collide with it.
        const tmp = `${fileFor(key)}.${process.pid}.${++written}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(value));
        await fs.promises.rename(tmp, fileFor(key));
      });
      const settled = write.catch(() => {});
      pending.set(key, settled);
      settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
      return write;
    },
    async delete(key) {
      await fs.promises.rm(fileFor(key), { force: true });
    },
  };
}

function openBackend(entry, i, baseDir, log) {
  const where = `storage.backends[${i}]`;
  if (entry?.type === 'file') {
    const dir = entry.dir || '.cache';
    return { label: `file ${dir}`, impl: fileBackend(path.resolve(baseDir, dir)) };
  }
  if (entry?.type === 'module') {
    const { type, path: rel, ...options } = entry;
    const file = path.resolve(baseDir, String(rel || ''));
    let mod;
    try {
      mod = require(file);
    } catch (e) {
      throw new Error(`${where}: cannot load ${file}: ${e.message}`);
    }
    if (typeof mod.createStorage !== 'function') throw new Error(`${where}: ${file} must export createStorage(options, { log, request })`);
    const request = (url, opts = {}) => http.request(url, { platform: 'azure', ...opts });
    const impl = mod.createStorage({ ...options, baseDir }, { log, request });
    return { label: impl.name || `module ${rel}`, impl };
  }
  throw new Error(`${where}: unknown type "${entry?.type}" (use file or module)`);
}

function checkKey(key) {
  if (!KEY.test(key)) throw new Error(`invalid storage key "${key}"`);
}

function createStorage(backends = [], { baseDir = process.cwd(), log = require('./log').log } = {}) {
  const opened = backends.map((b, i) => openBackend(b, i, baseDir, log));

  async function everywhere(op, key, fn) {
    await Promise.all(opened.map(async (b) => {
      try {
        await fn(b.impl);
      } catch (e) {
        log.warn(`storage.${op}_failed`, { backend: b.label, key, error: e.message });
      }
    }));
  }

  return {
    backends: opened.map((b) => b.label),
    async get(key) {
      checkKey(key);
      for (const b of opened) {
        try {
          const value = await b.impl.get(key);
          if (value != null) return value;
        } catch (e) {
          log.warn('storage.read_failed', { backend: b.label, key, error: e.message });
        }
      }
      return null;
    },
    async set(key, value) {
      checkKey(key);
      await everywhere('write', key, (impl) => impl.set(key, value));
    },
    async delete(key) {
      checkKey(key);
      await everywhere('delete', key, (impl) => impl.delete(key));
    },
    // Writes, reads back and deletes a test document in each backend.
    async check() {
      return Promise.all(opened.map(async (b) => {
        const probe = { at: Date.now() };
        try {
          await b.impl.set(CHECK_KEY, probe);
          const back = await b.impl.get(CHECK_KEY);
          await b.impl.delete(CHECK_KEY);
          const ok = back?.at === probe.at;
          return { backend: b.label, ok, error: ok ? null : 'value read back did not match' };
        } catch (e) {
          return { backend: b.label, ok: false, error: e.message };
        }
      }));
    },
  };
}

module.exports = { createStorage };
