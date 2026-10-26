'use strict';
// Structured logging to stdout: one JSON object per line, which container platforms (Azure Container
// Apps sends stdout to Log Analytics) collect without configuration. At a terminal the lines are
// printed human-readable instead. An optional file also receives every record as JSON.
//   record: { time, level: info|warn|error|audit, event, ...fields }
// Field names that look like credentials are redacted.

const fs = require('fs');
const path = require('path');

const SECRET_FIELD = /token|secret|password|authorization|credential/i;

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = SECRET_FIELD.test(k) ? '[redacted]' : v;
  return out;
}

function pretty(r) {
  const { time, level, event, ...fields } = r;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return `${time.slice(11, 19)} ${level.toUpperCase()} ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`;
}

function createLogger({ format = 'auto', stream = process.stdout, file = null, now = () => new Date() } = {}) {
  const asJson = format === 'json' || (format === 'auto' && !stream.isTTY);
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (level) => (event, fields) => {
    const record = { time: now().toISOString(), level, event, ...redact(fields) };
    const line = JSON.stringify(record) + '\n';
    stream.write(asJson ? line : pretty(record));
    if (file) fs.appendFileSync(file, line);
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), audit: write('audit') };
}

// Process-wide logger, replaced by configureLog() once the config is loaded.
let current = createLogger();
const log = {
  info: (e, f) => current.info(e, f),
  warn: (e, f) => current.warn(e, f),
  error: (e, f) => current.error(e, f),
  audit: (e, f) => current.audit(e, f),
};
function configureLog(options) { current = createLogger(options); }

module.exports = { createLogger, configureLog, log };
