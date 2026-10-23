'use strict';

/**
 * diagnostics.js
 *
 * Looks at one session and reports the habits that waste tokens.
 *
 * Diagnostics are returned as DATA, never as written text:
 *   { code, severity, sessionId, project, ts, impactTokens, params }
 * The browser turns `code` + `params` into a sentence in the language the
 * person chose, using the keys diag.<code>.title / .detail and tips.<code>.
 *
 * `impactTokens` is an estimate of the tokens involved in the problem. It is a
 * count of tokens, not money, and different diagnostics measure different things,
 * so use it to compare problems of the same kind or to spot the biggest ones.
 */

/** Rough size of a text in tokens (about 4 characters per token). */
const CHARS_PER_TOKEN = 4;
const { CACHE_TTL_MS, RESUMED_CACHE_MIN_TOKENS, RESUMED_CACHE_CONTEXT_RATIO } = require('./config');

function round1(n) {
  return Math.round(n * 10) / 10;
}

function sum(list, fn) {
  let total = 0;
  for (let i = 0; i < list.length; i += 1) total += fn(list[i]);
  return total;
}

function totalTokens(turn) {
  return turn.input + turn.output + turn.cacheWrite + turn.cacheRead;
}

/**
 * Split an ordered list of turns into stretches separated by /clear or /compact
 * (manual or automatic). Context starts fresh after each of them.
 */
function splitByResets(turns, events) {
  const resets = events.filter(function (e) { return e.kind === 'clear' || e.kind === 'compact'; });
  const segments = [[]];
  let r = 0;
  turns.forEach(function (turn) {
    while (r < resets.length && resets[r].ts <= turn.ts) {
      if (segments[segments.length - 1].length > 0) segments.push([]);
      r += 1;
    }
    segments[segments.length - 1].push(turn);
  });
  return segments.filter(function (s) { return s.length > 0; });
}

/** Session too long: big context, or many turns without /clear or /compact. */
function longSession(mainTurns, events, th, base) {
  const out = [];
  splitByResets(mainTurns, events).forEach(function (segment) {
    let crossIndex = -1;
    let maxContext = 0;
    segment.forEach(function (turn, i) {
      if (turn.ctx > maxContext) maxContext = turn.ctx;
      if (crossIndex < 0 && (turn.ctx > th.longSession.contextTokens || i + 1 > th.longSession.turns)) {
        crossIndex = i;
      }
    });
    if (crossIndex < 0) return;
    const affected = segment.slice(crossIndex);
    out.push(Object.assign({}, base, {
      code: 'long_session',
      severity: 'warn',
      ts: segment[crossIndex].ts,
      // Tokens the model had to read from the moment the limit was crossed.
      impactTokens: Math.round(sum(affected, function (t) { return t.ctx; })),
      params: {
        turns: segment.length,
        maxContext: maxContext,
        thresholdContext: th.longSession.contextTokens,
        thresholdTurns: th.longSession.turns
      }
    }));
  });
  return out;
}

/** True when a /clear or /compact happened in the time between two turns. */
function resetBetween(events, fromTs, toTs) {
  return events.some(function (e) {
    return (e.kind === 'clear' || e.kind === 'compact') && e.ts > fromTs && e.ts <= toTs;
  });
}

/** Cache lost after a pause: a long gap followed by a large cache write. */
function cacheLostAfterPause(mainTurns, events, th, base) {
  const out = [];
  const gapMs = th.cacheMiss.gapSeconds * 1000;
  for (let i = 1; i < mainTurns.length; i += 1) {
    const prev = mainTurns[i - 1];
    const turn = mainTurns[i];
    const gap = turn.ts - prev.ts;
    if (gap > gapMs && turn.cacheWrite > th.cacheMiss.cacheWriteTokens && !resetBetween(events, prev.ts, turn.ts)) {
      out.push(Object.assign({}, base, {
        code: 'cache_miss',
        severity: 'warn',
        ts: turn.ts,
        impactTokens: Math.round(turn.cacheWrite),
        params: { gapMinutes: round1(gap / 60000), cacheWriteTokens: turn.cacheWrite }
      }));
    }
  }
  return out;
}

/** Aggregate context rewrites after long pauses into one resumed-session issue. */
function resumedSession(mainTurns, events, th, base) {
  const resumptions = [];
  for (let i = 1; i < mainTurns.length; i += 1) {
    const prev = mainTurns[i - 1];
    const turn = mainTurns[i];
    const gap = turn.ts - prev.ts;
    // Flag only a non-initial turn after cache expiry that rewrites at least
    // 20k tokens and at least 80% of the preceding turn's context.
    if (gap > CACHE_TTL_MS && prev.ctx > 0 &&
        turn.cacheWrite >= RESUMED_CACHE_MIN_TOKENS &&
        turn.cacheWrite / prev.ctx >= RESUMED_CACHE_CONTEXT_RATIO &&
        !resetBetween(events, prev.ts, turn.ts)) {
      resumptions.push(turn);
    }
  }
  if (resumptions.length === 0) return [];
  const cacheCreationTokens = Math.round(sum(resumptions, function (turn) { return turn.cacheWrite; }));
  return [Object.assign({}, base, {
    code: 'resumed_session',
    severity: 'warn',
    ts: resumptions[resumptions.length - 1].ts,
    impactTokens: cacheCreationTokens,
    params: {
      count: resumptions.length,
      cacheCreationTokens: cacheCreationTokens,
      gapMinutes: CACHE_TTL_MS / 60000
    }
  })];
}

/** A single tool result that put a huge amount of text into the conversation. */
function hugeToolResults(toolResults, th, base) {
  return toolResults
    .filter(function (r) { return r.chars > th.hugeToolResult.chars; })
    .map(function (r) {
      return Object.assign({}, base, {
        code: 'huge_tool_result',
        severity: 'warn',
        ts: r.ts,
        impactTokens: Math.ceil(r.chars / CHARS_PER_TOKEN),
        params: {
          tool: r.tool,
          chars: r.chars,
          tokens: Math.ceil(r.chars / CHARS_PER_TOKEN),
          // First lines of the result. Stripped from exports and from history.json.
          preview: r.preview
        }
      });
    });
}

/** Expensive model used for turns that produced very little output. */
function expensiveModel(allTurns, th, base) {
  let pattern;
  try { pattern = new RegExp(th.expensiveModel.modelPattern, 'i'); } catch (e) { return []; }
  const expensive = allTurns.filter(function (t) { return pattern.test(t.model); });
  if (expensive.length === 0) return [];
  const short = expensive.filter(function (t) { return t.output < th.expensiveModel.shortOutputTokens; });
  if (short.length < th.expensiveModel.minShortTurns) return [];
  if (short.length / expensive.length < th.expensiveModel.minShortShare) return [];

  const all = sum(allTurns, totalTokens);
  const share = all > 0 ? (sum(expensive, totalTokens) / all) * 100 : 0;
  return [Object.assign({}, base, {
    code: 'expensive_model',
    severity: 'warn',
    ts: short[0].ts,
    impactTokens: Math.round(sum(short, totalTokens)),
    params: {
      opusPercent: round1(share),
      shortTurns: short.length,
      opusTurns: expensive.length,
      maxOutput: th.expensiveModel.shortOutputTokens
    }
  })];
}

/** Subagent usage (lines with isSidechain true), reported per session. */
function subagents(allTurns, th, base) {
  const side = allTurns.filter(function (t) { return t.sidechain; });
  if (side.length === 0) return [];
  const tokens = sum(side, totalTokens);
  if (tokens < th.subagents.minTokens) return [];
  const all = sum(allTurns, totalTokens);
  return [Object.assign({}, base, {
    code: 'subagents',
    severity: 'info',
    ts: side[0].ts,
    impactTokens: Math.round(tokens),
    params: {
      tokens: Math.round(tokens),
      percent: round1(all > 0 ? (tokens / all) * 100 : 0),
      turns: side.length
    }
  })];
}

/**
 * Run every diagnostic on one session.
 * `session` needs: id, project, allTurns, mainTurns, events (sorted), toolResults.
 */
function analyzeSession(session, th) {
  const base = { sessionId: session.id, project: session.project };
  const list = []
    .concat(longSession(session.mainTurns, session.events, th, base))
    .concat(cacheLostAfterPause(session.mainTurns, session.events, th, base))
    .concat(resumedSession(session.mainTurns, session.events, th, base))
    .concat(hugeToolResults(session.toolResults, th, base))
    .concat(expensiveModel(session.allTurns, th, base))
    .concat(subagents(session.allTurns, th, base));
  list.sort(function (a, b) { return b.impactTokens - a.impactTokens; });
  return list;
}

/**
 * Markers for the session chart, positioned by turn index (0-based) in `turns`:
 *   clear, compact, autoCompact, pause (long gap) and spike (sudden context jump).
 */
function detectMarkers(turns, events, th) {
  const markers = [];
  if (turns.length === 0) return markers;

  events.forEach(function (e) {
    if (e.kind !== 'clear' && e.kind !== 'compact') return;
    let index = turns.findIndex(function (t) { return t.ts >= e.ts; });
    if (index < 0) index = turns.length - 1;
    markers.push({ i: index, kind: e.kind === 'clear' ? 'clear' : (e.auto ? 'autoCompact' : 'compact') });
  });

  for (let i = 1; i < turns.length; i += 1) {
    const gap = turns[i].ts - turns[i - 1].ts;
    if (gap > th.pause.gapSeconds * 1000) {
      markers.push({ i: i, kind: 'pause', gapMinutes: round1(gap / 60000) });
    }
    const jump = turns[i].ctx - turns[i - 1].ctx;
    if (jump >= th.spike.minIncreaseTokens) {
      markers.push({ i: i, kind: 'spike', delta: Math.round(jump), value: turns[i].ctx });
    }
  }
  markers.sort(function (a, b) { return a.i - b.i; });
  return markers;
}

module.exports = {
  analyzeSession: analyzeSession,
  detectMarkers: detectMarkers
};
