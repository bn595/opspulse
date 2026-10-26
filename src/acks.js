'use strict';
// Acknowledged and snoozed feed items. An entry applies only while the item's title is unchanged,
// so "3 failures" acknowledged resurfaces as "5 failures". Acknowledging an id again replaces its
// entry, so at most one entry is kept per item id. Persisted through a storage backend, if given.

function createAcks({ storage = null, key = 'acks', now = Date.now } = {}) {
  const entries = new Map(); // id -> { title, until }

  // Drops expired snoozes and persists. Resolves once stored.
  function save() {
    for (const [id, e] of entries) if (e.until != null && e.until <= now()) entries.delete(id);
    return storage ? storage.set(key, Object.fromEntries(entries)) : Promise.resolve();
  }

  // Validates and records synchronously; the returned promise resolves once stored.
  function record(item, until) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.id || !item.title) throw new Error('id and title are required');
    entries.set(item.id, { title: item.title, until });
    return save();
  }

  function mutedState(i) {
    const e = entries.get(i.id);
    if (!e || e.title !== i.title) return null;
    if (e.until == null) return { kind: 'acknowledged' };
    return e.until > now() ? { kind: 'snoozed', until: new Date(e.until).toISOString() } : null;
  }

  return {
    // Loads stored entries; call once before use.
    async load() {
      const stored = storage ? await storage.get(key) : null;
      for (const [id, e] of Object.entries(stored || {})) entries.set(id, e);
    },
    acknowledge(item) {
      return record(item, null);
    },
    snooze(item, hours) {
      if (typeof hours !== 'number' || !(hours >= 1 && hours <= 720)) throw new Error('hours must be between 1 and 720');
      return record(item, now() + hours * 3600e3);
    },
    restore(id) {
      return entries.delete(id) ? save() : Promise.resolve();
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
