'use strict';
// Where opspulse keeps state between restarts (the snapshot cache, acknowledgements). Configured as a
// list of backends: none (memory only), one, or several. Writes go to every backend; reads come from
// the first backend that has the document. A failing backend is logged and skipped.
//
// A backend stores JSON documents by key:
//   { name?, async get(key) -> value | null, async set(key, value), async delete(key) }
// Built-in: { type: 'file', dir }. Custom: { type: 'module', path, ...options }, where the module
// exports createStorage(options, { log }) returning a backend.

const fs = require('fs');
const path = require('path');

const KEY = /^[a-z0-9][a-z0-9-]*$/i;
const CHECK_KEY = 'opspulse-check';

function fileBackend(dir) {
  const fileFor = (key) => path.join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await fs.promises.readFile(fileFor(key), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async set(key, value) {
      await fs.promises.mkdir(dir, { recursive: true });
      // Write then rename, so a crash never leaves a half-written document.
      const tmp = `${fileFor(key)}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(value));
      await fs.promises.rename(tmp, fileFor(key));
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
    if (typeof mod.createStorage !== 'function') throw new Error(`${where}: ${file} must export createStorage(options, { log })`);
    const impl = mod.createStorage({ ...options, baseDir }, { log });
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
