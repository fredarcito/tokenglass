'use strict';

/**
 * history.js
 *
 * Claude Code deletes old sessions after a while. To keep the statistics, every
 * time the data is read we save a small summary of each session (and of each
 * day, which is derived from the sessions) to:
 *
 *     ~/.claude-token-dashboard/history.json      (never inside the repository)
 *
 * Merging rule, without duplicates:
 *   - a session that still exists in the .jsonl files uses the CURRENT data;
 *   - a session whose files were deleted keeps the SAVED summary.
 *
 * Only numbers and session labels are stored: no prompts, no code, no tool output.
 * (Tool-result previews are removed from the saved diagnostics.)
 *
 * This is the only place where the tool writes anything, and it writes only
 * inside the app folder.
 */

const fs = require('fs');
const path = require('path');
const { assertInside } = require('./config');

const HISTORY_FILE = 'history.json';
const VERSION = 1;

/** Copy of a session that is safe and small enough to keep on disk. */
function toSummary(session) {
  return {
    id: session.id,
    project: session.project,
    projectName: session.projectName,
    title: session.title || '',
    start: session.start,
    end: session.end,
    durationMs: session.durationMs,
    activeDurationMs: session.activeDurationMs,
    firstContext: session.firstContext,
    turns: session.turns,
    assistantLines: session.assistantLines,
    assistantMessageCount: session.assistantMessageCount,
    sidechainTurns: session.sidechainTurns,
    maxContext: session.maxContext,
    resets: session.resets,
    summaryMarkers: session.summaryMarkers,
    rows: session.rows,
    diagnostics: session.diagnostics.map(function (d) {
      const params = Object.assign({}, d.params);
      delete params.preview;
      return Object.assign({}, d, { params: params });
    })
  };
}

/**
 * Read history.json. Never throws.
 * Returns { sessions: { [id]: summary }, warning, raw } where `warning` is
 * { code, params } when the file was unreadable (it is renamed, not deleted).
 */
function loadHistory(appDir) {
  const file = path.join(appDir, HISTORY_FILE);
  const empty = { sessions: {}, warning: null, raw: '{}' };
  let text;
  try {
    assertInside(appDir, file);
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return empty;
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || typeof data.sessions !== 'object' || data.sessions === null) {
      throw new Error('bad shape');
    }
    return { sessions: data.sessions, warning: null, raw: JSON.stringify(data.sessions) };
  } catch (e) {
    const backup = HISTORY_FILE.replace(/\.json$/, '') + '.corrupt-' + Date.now() + '.json';
    try {
      fs.renameSync(file, path.join(appDir, backup));
      return { sessions: {}, warning: { code: 'historyCorrupt', params: { backup: backup } }, raw: '{}' };
    } catch (renameError) {
      return { sessions: {}, warning: { code: 'historyUnavailable', params: { dir: appDir } }, raw: '{}' };
    }
  }
}

/**
 * Combine the sessions read from disk with the saved ones.
 * Returns the full list, each session with `live: true|false`.
 */
function mergeSessions(liveSessions, saved) {
  const merged = liveSessions.map(function (s) { return Object.assign({}, s, { live: true }); });
  const liveIds = new Set(liveSessions.map(function (s) { return s.id; }));
  Object.keys(saved).forEach(function (id) {
    if (liveIds.has(id)) return;
    const s = saved[id];
    if (!s || typeof s !== 'object' || !Array.isArray(s.rows)) return;
    merged.push(Object.assign({}, s, {
      live: false,
      series: null,
      markers: [],
      diagnostics: Array.isArray(s.diagnostics) ? s.diagnostics : []
    }));
  });
  return merged;
}

/** One summary per day, derived from the session rows (written for convenience, never read back). */
function buildDays(sessions) {
  const days = {};
  sessions.forEach(function (s) {
    const seen = new Set();
    s.rows.forEach(function (r) {
      const day = days[r.d] || (days[r.d] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0, sessions: 0 });
      day.input += r.i;
      day.output += r.o;
      day.cacheWrite += r.cw;
      day.cacheRead += r.cr;
      day.turns += r.n;
      if (!seen.has(r.d)) {
        seen.add(r.d);
        day.sessions += 1;
      }
    });
  });
  return days;
}

/**
 * Save the merged summaries. Returns { saved: boolean, warning }.
 * Skips the write when nothing changed. The file is written to a temporary
 * name first and then renamed, so a crash cannot leave a half-written history.
 */
function saveHistory(appDir, mergedSessions, previousRaw) {
  const summaries = {};
  mergedSessions.forEach(function (s) { summaries[s.id] = toSummary(s); });

  const serialized = JSON.stringify(summaries);
  if (serialized === previousRaw) return { saved: false, warning: null };

  const file = path.join(appDir, HISTORY_FILE);
  const tmp = file + '.tmp-' + process.pid;
  try {
    assertInside(appDir, file);
    fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
    const payload = {
      version: VERSION,
      updatedAt: new Date().toISOString(),
      days: buildDays(mergedSessions),
      sessions: summaries
    };
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { saved: true, warning: null };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (cleanupError) { /* nothing to clean */ }
    return { saved: false, warning: { code: 'historyUnavailable', params: { dir: appDir } } };
  }
}

module.exports = {
  loadHistory: loadHistory,
  mergeSessions: mergeSessions,
  saveHistory: saveHistory
};
