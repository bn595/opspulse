'use strict';
// Template for a storage backend, e.g. Azure Blob Storage. Copy it, fill in the three methods, and list
// it in config.json:
//
//   "storage": { "backends": [{ "type": "module", "path": "./storage/blob.js", "container": "opspulse" }] }
//
// Every key other than `type` and `path` arrives in `options`, along with `baseDir` (the config
// file's directory). Documents are small JSON values (the largest is the dashboard snapshot).
// Keys are short names such as "snapshot" and "acks". Verify a backend with `npm run check`.
//
// Contract:
//   get(key)        -> the stored value, or null if there is none
//   set(key, value) -> store value (replace any existing one)
//   delete(key)     -> remove it (no error if it does not exist)
// Throw on failure; opspulse logs the error and carries on with the other backends.
//
// Make HTTP calls with `request`, not fetch or an SDK: it goes through the configured proxy and CA
// (network.proxies.azure by default; pass { platform } to use another) and opspulse's rate limiting.
//   const res = await request(url, { method: 'PUT', headers, body }); // -> { status, headers, data }

function createStorage(options, { log, request }) {
  return {
    name: `template ${options.container || ''}`.trim(),
    async get(key) {
      throw new Error(`not implemented: get ${key}`);
    },
    async set(key, value) {
      throw new Error(`not implemented: set ${key} (${JSON.stringify(value).length} bytes)`);
    },
    async delete(key) {
      throw new Error(`not implemented: delete ${key}`);
    },
  };
}

module.exports = { createStorage };
