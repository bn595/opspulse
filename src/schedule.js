'use strict';
// Decides which sources refresh now. Intervals count from the last attempt, so a failing source
// is not retried in a tight loop; a rate-limited source waits for its block to end.
//   intervals    { source: minutes }
//   lastAttempt  { source: epoch ms }
//   blockedUntil { source: epoch ms }
// Returns { due: [source], nextAt: epoch ms | null }.

function planRefresh({ intervals, lastAttempt = {}, blockedUntil = {}, now, force = false }) {
  const due = [];
  let nextAt = null;
  for (const [source, minutes] of Object.entries(intervals)) {
    const blocked = blockedUntil[source] > now;
    const dueAt = lastAttempt[source] == null ? now : lastAttempt[source] + minutes * 60e3;
    if (!blocked && (force || dueAt <= now)) {
      due.push(source);
      continue;
    }
    const next = blocked ? Math.max(blockedUntil[source], dueAt) : dueAt;
    if (nextAt == null || next < nextAt) nextAt = next;
  }
  return { due, nextAt };
}

module.exports = { planRefresh };
