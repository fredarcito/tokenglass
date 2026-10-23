'use strict';

/**
 * data.js
 *
 * Orchestrates one full read:
 *   1. find the .jsonl files,
 *   2. parse them (parser.js),
 *   3. build one summary per session and run the diagnostics (diagnostics.js),
 *   4. merge with the saved history and save it again (history.js),
 *   5. return the aggregated payload that /api/data serves.
 *
 * The browser receives numbers and codes, never finished sentences.
 */

const pkg = require('../package.json');
const parser = require('./parser');
const diagnostics = require('./diagnostics');
const history = require('./history');
const { displayPath, IDLE_THRESHOLD_MS } = require('./config');

/** Longest series sent to the browser for one session (longer ones are sampled). */
const MAX_SERIES_POINTS = 1500;

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Local calendar date (YYYY-MM-DD) of a timestamp. */
function localDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Last folder name of a path, for both "/" and "\" separators. */
function lastSegment(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function byTs(a, b) {
  const aValid = Number.isFinite(a.ts);
  const bValid = Number.isFinite(b.ts);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && a.ts !== b.ts) return a.ts - b.ts;
  return (a.seq || 0) - (b.seq || 0);
}

/** Sum consecutive message gaps, excluding gaps longer than the idle threshold. */
function activeDuration(messages) {
  let duration = 0;
  const timed = messages.filter(function (message) { return Number.isFinite(message.ts); }).slice().sort(byTs);
  for (let i = 1; i < timed.length; i += 1) {
    const gap = timed[i].ts - timed[i - 1].ts;
    if (Number.isFinite(gap) && gap > 0 && gap <= IDLE_THRESHOLD_MS) duration += gap;
  }
  return duration;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort(function (a, b) { return a - b; });
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Sum of the four token counters per day and model (the building block of every chart). */
function buildRows(turns) {
  const rows = new Map();
  turns.forEach(function (t) {
    const day = Number.isFinite(t.ts) ? localDate(t.ts) : null;
    const key = day + '|' + t.model;
    let row = rows.get(key);
    if (!row) {
      row = { d: day, m: t.model, i: 0, o: 0, cw: 0, cr: 0, n: 0, sn: 0, s: 0 };
      rows.set(key, row);
    }
    row.i += t.input;
    row.o += t.output;
    row.cw += t.cacheWrite;
    row.cr += t.cacheRead;
    row.n += 1;
    if (t.sidechain) {
      row.sn += 1;
      row.s += t.input + t.output + t.cacheWrite + t.cacheRead;
    }
  });
  return Array.from(rows.values()).sort(function (a, b) {
    if (a.d === null || b.d === null) return a.d === b.d ? 0 : (a.d === null ? 1 : -1);
    return a.d < b.d ? -1 : a.d > b.d ? 1 : a.m < b.m ? -1 : 1;
  });
}

/** Context-per-turn series for the session detail chart (sampled if very long). */
function buildSeries(chartTurns) {
  const total = chartTurns.length;
  if (total === 0) return null;
  const step = Math.max(1, Math.ceil(total / MAX_SERIES_POINTS));
  const picked = [];
  const x = [];
  for (let i = 0; i < total; i += step) {
    picked.push(chartTurns[i]);
    x.push(i + 1);
  }
  if ((total - 1) % step !== 0) {
    picked.push(chartTurns[total - 1]);
    x.push(total);
  }
  const series = {
    n: total,
    t: picked.map(function (t) { return t.ts; }),
    ctx: picked.map(function (t) { return t.ctx; }),
    out: picked.map(function (t) { return t.output; })
  };
  if (step > 1) series.x = x;
  return series;
}

/** Build the summary (plus chart data and diagnostics) of every session that has assistant turns. */
function buildSessions(parsedSessions, config) {
  const th = config.thresholds;
  const result = [];

  parsedSessions.forEach(function (raw) {
    const allTurns = raw.turns.slice().sort(byTs);
    if (allTurns.length === 0) return;
    const mainTurns = allTurns.filter(function (t) { return !t.sidechain; });
    const events = raw.events.slice().sort(byTs);
    const timedTurns = allTurns.filter(function (t) { return Number.isFinite(t.ts); });
    const timedMainTurns = mainTurns.filter(function (t) { return Number.isFinite(t.ts); });
    const chartTurns = timedMainTurns.length ? timedMainTurns : timedTurns;
    const timedMessages = Array.isArray(raw.messages) ? raw.messages.filter(function (m) { return Number.isFinite(m.ts); }) : [];

    const project = raw.project || raw.folder || '';
    const timestamps = timedMessages.map(function (m) { return m.ts; });
    const start = timestamps.length ? Math.min.apply(null, timestamps) : null;
    const end = timestamps.length ? Math.max.apply(null, timestamps) : null;
    const firstContextTurn = mainTurns.length ? mainTurns[0] : null;
    const title = raw.aiTitle || raw.firstUserTitle || '';

    const session = {
      id: raw.id,
      project: project,
      projectName: lastSegment(project),
      title: title,
      start: start,
      end: end,
      durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      activeDurationMs: activeDuration(timedMessages),
      firstContext: firstContextTurn && Number.isFinite(firstContextTurn.ctx) ? firstContextTurn.ctx : null,
      turns: mainTurns.length,
      sidechainTurns: allTurns.length - mainTurns.length,
      assistantLines: raw.assistantLines,
      assistantMessageCount: raw.assistantMessageCount,
      maxContext: chartTurns.reduce(function (max, t) { return t.ctx > max ? t.ctx : max; }, 0),
      resets: {
        clear: events.filter(function (e) { return e.kind === 'clear'; }).length,
        compact: events.filter(function (e) { return e.kind === 'compact' && !e.auto; }).length,
        auto: events.filter(function (e) { return e.kind === 'compact' && e.auto; }).length
      },
      summaryMarkers: raw.summaryMarkers,
      rows: buildRows(allTurns)
    };

    session.diagnostics = diagnostics.analyzeSession({
      id: raw.id,
      project: project,
      allTurns: timedTurns,
      mainTurns: timedMainTurns,
      events: events.filter(function (event) { return Number.isFinite(event.ts); }),
      toolResults: raw.toolResults
    }, th);
    session.series = buildSeries(chartTurns);
    session.markers = diagnostics.detectMarkers(chartTurns, events.filter(function (event) { return Number.isFinite(event.ts); }), th);
    result.push(session);
  });

  return result;
}

/**
 * Read everything and return the payload for /api/data.
 *
 * ctx = { example, dataDir, appDir, config, configWarnings, defaultLang }
 */
async function loadDashboardData(ctx) {
  const found = parser.listJsonlFiles(ctx.dataDir);
  const parsed = await parser.parseFiles(found.files, {
    keepToolResultsAbove: ctx.config.thresholds.hugeToolResult.chars
  });

  const live = buildSessions(parsed.sessions, ctx.config);
  const warnings = ctx.configWarnings.slice();
  let sessions = live.map(function (s) { return Object.assign({}, s, { live: true }); });
  let historyOnly = 0;

  // Example mode never reads or writes the history.
  if (!ctx.example) {
    const loaded = history.loadHistory(ctx.appDir);
    if (loaded.warning) warnings.push(loaded.warning);
    sessions = history.mergeSessions(live, loaded.sessions);
    historyOnly = sessions.filter(function (s) { return !s.live; }).length;
    const saved = history.saveHistory(ctx.appDir, sessions, loaded.raw);
    if (saved.warning) warnings.push(saved.warning);
  }

  // Diagnostics travel in one list, sorted by impact.
  const allDiagnostics = [];
  sessions.forEach(function (s) {
    s.diagnostics.forEach(function (d) { allDiagnostics.push(d); });
  });
  allDiagnostics.sort(function (a, b) { return b.impactTokens - a.impactTokens; });

  let emptyReason = null;
  if (sessions.length === 0) {
    if (!found.exists) emptyReason = 'missingDir';
    else if (found.files.length === 0) emptyReason = 'noFiles';
    else emptyReason = 'noTurns';
  }

  return {
    meta: {
      version: pkg.version,
      generatedAt: Date.now(),
      example: Boolean(ctx.example),
      dataDir: displayPath(ctx.dataDir),
      filesRead: parsed.stats.files,
      linesRead: parsed.stats.lines,
      linesIgnored: parsed.stats.ignored,
      lineQuality: {
        malformed: parsed.stats.malformed,
        unreadableFiles: parsed.stats.filesUnreadable,
        invalidTimestamps: parsed.stats.invalidTimestamps,
        assistantLines: parsed.stats.assistantLines,
        duplicateAssistantLines: parsed.stats.duplicates,
        duplicateUsageDifferences: parsed.stats.duplicateUsageDifferences,
        noUsage: parsed.stats.assistantNoUsage,
        synthetic: parsed.stats.synthetic,
        zeroUsage: parsed.stats.assistantZeroUsage
      },
      historyOnlySessions: historyOnly,
      empty: emptyReason !== null,
      emptyReason: emptyReason,
      defaultLang: ctx.defaultLang || null,
      thresholds: ctx.config.thresholds,
      sessionInactivityGapMs: IDLE_THRESHOLD_MS,
      sessionBaselineContext: median(sessions.map(function (s) { return s.firstContext; })),
      weights: ctx.config.weights,
      warnings: warnings
    },
    sessions: sessions.map(function (s) {
      // Diagnostics are sent once, in the top-level list.
      const copy = Object.assign({}, s);
      delete copy.diagnostics;
      return copy;
    }),
    diagnostics: allDiagnostics
  };
}

module.exports = {
  loadDashboardData: loadDashboardData,
  buildSessions: buildSessions,
  activeDuration: activeDuration,
  localDate: localDate
};
