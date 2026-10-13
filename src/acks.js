'use strict';
// Acknowledged and snoozed feed items. An entry applies only while the item's title is unchanged,
// so "3 failures" acknowledged resurfaces as "5 failures". Optionally persisted to a JSON file.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;

function createAcks({ file = null, now = Date.now } = {}) {
  const entries = new Map(); // id -> { title, until, at }
  if (file) {
    try {
      for (const [id, e] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) entries.set(id, e);
    } catch { /* missing or unreadable: start empty */ }
  }

  function save() {
    const cutoff = now() - KEEP_DAYS * 86400e3;
    for (const [id, e] of entries) if (e.at < cutoff || (e.until != null && e.until <= now())) entries.delete(id);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
  }

  function set(item, until) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.id || !item.title) throw new Error('id and title are required');
    entries.set(item.id, { title: item.title, until, at: now() });
    save();
  }

  function mutedState(i) {
    const e = entries.get(i.id);
    if (!e || e.title !== i.title) return null;
    if (e.until == null) return { kind: 'acknowledged' };
    return e.until > now() ? { kind: 'snoozed', until: new Date(e.until).toISOString() } : null;
  }

  return {
    acknowledge(item) {
      set(item, null);
    },
    snooze(item, hours) {
      if (typeof hours !== 'number' || !(hours >= 1 && hours <= 720)) throw new Error('hours must be between 1 and 720');
      set(item, now() + hours * 3600e3);
    },
    restore(id) {
      if (entries.delete(id)) save();
    },
    annotate(items) {
      return items.map((i) => {
        const muted = mutedState(i);
        return muted ? { ...i, muted } : i;
      });
    },
  };
}

module.exports = { createAcks };
