'use strict';

/**
 * parser.js
 *
 * Reads Claude Code transcript files (.jsonl, one JSON object per line) and
 * turns them into sessions made of turns, events and tool results.
 *
 * The file format is NOT officially documented and can change between Claude
 * Code versions, so everything here is defensive:
 *   - lines that are not valid JSON are skipped and counted;
 *   - the only fields treated as required are `timestamp` and, on assistant
 *     responses, `message.usage`;
 *   - every other field falls back to a sensible default.
 *
 * The function names below (parseLine, readTimestamp, resolveSession,
 * handleAssistant, dedupKey, extractUsage, handleUser, detectCommands,
 * extractToolResults) are referenced by `npm run check` when it tells you which
 * part of the parser to review, so keep them in sync with src/check.js.
 *
 * This module only READS files. It never modifies, moves or deletes them.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { isInside } = require('./config');

/** usage fields every assistant response is expected to have. */
const EXPECTED_USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
];

/** Top-level fields we hope to find on assistant lines (used by the check report). */
const TRACKED_FIELDS = ['timestamp', 'sessionId', 'cwd', 'isSidechain', 'requestId', 'message.id', 'message.model'];

/** Max time between a /compact command and its summary line to treat them as one event. */
const COMPACT_PAIR_WINDOW_MS = 30 * 60 * 1000;

const MAX_DISTINCT_NAMES = 50;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

/** Keep only harmless characters when we count names found in the data (type values, field names). */
function safeName(value) {
  return String(value).replace(/[^\w.\-:<>]/g, '?').slice(0, 40);
}

function bump(map, name) {
  let key = safeName(name);
  if (!Object.prototype.hasOwnProperty.call(map, key) && Object.keys(map).length >= MAX_DISTINCT_NAMES) {
    key = '(other)';
  }
  map[key] = (map[key] || 0) + 1;
}

/* ------------------------------------------------------------------ */
/* Finding files                                                       */
/* ------------------------------------------------------------------ */

/**
 * List every .jsonl file under `root`, in all sub-folders.
 * Symbolic links are followed only when they stay inside `root`.
 * Returns { exists, files } where files are { path, mtimeMs } sorted oldest first.
 */
function listJsonlFiles(root) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) return { exists: false, files: [] };
  } catch (e) {
    return { exists: false, files: [] };
  }

  const files = [];
  const visited = new Set();

  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { return; }
    if (!isInside(realRoot, real) || visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch (e) { return; }

    entries.forEach(function (entry) {
      const full = path.join(real, entry.name);
      let stat;
      try { stat = fs.statSync(full); } catch (e) { return; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && /\.jsonl$/i.test(entry.name)) {
        let realFile;
        try { realFile = fs.realpathSync(full); } catch (e) { return; }
        if (isInside(realRoot, realFile)) files.push({ path: realFile, mtimeMs: stat.mtimeMs });
      }
    });
  }

  walk(realRoot);
  files.sort(function (a, b) { return a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1); });
  return { exists: true, files: files };
}

/* ------------------------------------------------------------------ */
/* Line-level readers                                                  */
/* ------------------------------------------------------------------ */

/** Parse one line of text. Returns an object, or null if it is not a JSON object. */
function parseLine(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch (e) {
    return null;
  }
}

/** Milliseconds since epoch, or null when the timestamp is missing or invalid. */
function readTimestamp(obj) {
  const raw = obj.timestamp;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const ms = typeof raw === 'number' ? raw : Date.parse(raw);
    if (isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/**
 * Find (or create) the session a line belongs to.
 * Uses `sessionId` when present, otherwise the file name.
 * The project is the first `cwd` seen; the parent folder name is the fallback.
 */
function resolveSession(obj, file, state) {
  const id = typeof obj.sessionId === 'string' && obj.sessionId
    ? obj.sessionId
    : (typeof obj.parentUuid === 'string' && state.parentSessions.has(obj.parentUuid)
      ? state.parentSessions.get(obj.parentUuid)
      : file.sessionFallback);
  let session = state.sessions.get(id);
  if (!session) {
    session = {
      id: id,
      project: null,
      folder: file.folder,
      firstTs: null,
      lastTs: null,
      assistantLines: 0,
      assistantByKey: new Map(),
      userMessageIds: new Set(),
      activityByKey: new Map(),
      aiTitle: '',
      firstUserTitle: '',
      events: [],
      toolResults: [],
      summaryMarkers: 0
    };
    state.sessions.set(id, session);
  }
  if (!session.project && typeof obj.cwd === 'string' && obj.cwd) session.project = obj.cwd;
  if (typeof obj.uuid === 'string' && obj.uuid) state.parentSessions.set(obj.uuid, id);
  file.lastSession = session;
  return session;
}

function touch(session, ts) {
  if (ts === null) return;
  if (session.firstTs === null || ts < session.firstTs) session.firstTs = ts;
  if (session.lastTs === null || ts > session.lastTs) session.lastTs = ts;
}

/**
 * Read the four token counters from a usage object.
 * If the flat cache_creation_input_tokens is missing, fall back to the nested
 * cache_creation breakdown (ephemeral_5m / ephemeral_1h).
 */
function extractUsage(usage, stats) {
  Object.keys(usage).forEach(function (name) { bump(stats.usageFields, name); });

  let cacheWrite = num(usage.cache_creation_input_tokens);
  if (usage.cache_creation_input_tokens === undefined && isObject(usage.cache_creation)) {
    cacheWrite = Object.keys(usage.cache_creation).reduce(function (sum, k) {
      return sum + num(usage.cache_creation[k]);
    }, 0);
  }
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite: cacheWrite,
    cacheRead: num(usage.cache_read_input_tokens)
  };
}

function hasUsage(tokens) {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead > 0;
}

/**
 * Deduplicate an assistant response by message.id. requestId / uuid are
 * fallbacks for transcript variants that omit message.id.
 */
function dedupKey(obj, message) {
  const id = message && typeof message.id === 'string' ? message.id : '';
  if (id) return 'message:' + id;
  const req = typeof obj.requestId === 'string' ? obj.requestId : '';
  if (req) return 'request:' + req;
  if (typeof obj.uuid === 'string' && obj.uuid) return 'uuid:' + obj.uuid;
  return null;
}

function userDedupKey(obj, message) {
  if (typeof obj.uuid === 'string' && obj.uuid) return 'uuid:' + obj.uuid;
  if (message && typeof message.id === 'string' && message.id) return 'message:' + message.id;
  return null;
}

/** First user-authored text suitable for a compact session label. */
function userTitle(content) {
  const candidates = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter(function (part) { return isObject(part) && part.type === 'text'; }).map(function (part) { return part.text; })
      : [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (typeof candidates[i] !== 'string') continue;
    let text = candidates[i].trim();
    if (!text || /^\/[a-z][\w-]*(?:\s|$)/i.test(text)) continue;
    if (/^<(?:command-|local-command|system-reminder|task-notification|antml:|function_results|environment_context|ide_)/i.test(text)) continue;
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
    if (text) return text.slice(0, 500);
  }
  return '';
}

function rememberActivity(session, key, ts, seq, kind) {
  if (ts === null) return;
  const previous = session.activityByKey.get(key);
  if (!previous) {
    session.activityByKey.set(key, { ts: ts, seq: seq, kind: kind });
  } else if (ts < previous.ts) {
    previous.ts = ts;
    previous.seq = seq;
  }
}

function preferAssistantCandidate(existing, candidate) {
  if (!existing) return true;
  if (candidate.output !== existing.output) return candidate.output > existing.output;
  return candidate.seq >= existing.seq;
}

/** Record which tracked fields this assistant line has (for the check report). */
function trackFields(obj, ts, stats) {
  const message = isObject(obj.message) ? obj.message : {};
  const present = {
    timestamp: ts !== null,
    sessionId: typeof obj.sessionId === 'string' && obj.sessionId !== '',
    cwd: typeof obj.cwd === 'string' && obj.cwd !== '',
    isSidechain: typeof obj.isSidechain === 'boolean',
    requestId: typeof obj.requestId === 'string' && obj.requestId !== '',
    'message.id': typeof message.id === 'string' && message.id !== '',
    'message.model': typeof message.model === 'string' && message.model !== ''
  };
  TRACKED_FIELDS.forEach(function (name) {
    if (present[name]) stats.fieldPresence[name] = (stats.fieldPresence[name] || 0) + 1;
  });
}

/** Assistant response: count its tokens once. */
function handleAssistant(obj, ts, file, state, seq) {
  const stats = state.stats;
  stats.assistantLines += 1;
  trackFields(obj, ts, stats);

  const message = isObject(obj.message) ? obj.message : null;
  const usage = message && isObject(message.usage) ? message.usage : null;
  if (usage) stats.usageObjects += 1;
  else stats.assistantNoUsage += 1;
  const tokens = usage ? extractUsage(usage, stats) : { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  if (!hasUsage(tokens)) stats.assistantZeroUsage += 1;
  if (ts === null) stats.assistantNoTimestamp += 1;
  const model = typeof message.model === 'string' && message.model ? message.model : 'unknown';
  if (model === '<synthetic>') stats.synthetic += 1;

  const session = resolveSession(obj, file, state);
  session.assistantLines += 1;
  touch(session, ts);

  // Remember tool names so tool_result blocks can say which tool produced them.
  if (Array.isArray(message.content)) {
    message.content.forEach(function (block) {
      if (isObject(block) && block.type === 'tool_use' && typeof block.id === 'string') {
        state.toolNames.set(block.id, safeName(block.name || 'unknown'));
      }
    });
  }

  const key = dedupKey(obj, message);
  const uniqueKey = key === null ? 'line:' + seq : key;
  if (key === null) stats.noDedupKey += 1;
  const candidate = {
    ts: ts,
    seq: seq,
    model: model,
    sidechain: obj.isSidechain === true,
    usagePresent: usage !== null,
    usageValid: usage !== null && model !== '<synthetic>' && hasUsage(tokens),
    input: tokens.input,
    output: tokens.output,
    cacheWrite: tokens.cacheWrite,
    cacheRead: tokens.cacheRead,
    ctx: tokens.input + tokens.cacheWrite + tokens.cacheRead
  };
  rememberActivity(session, 'assistant:' + uniqueKey, ts, seq, 'assistant');
  const existing = session.assistantByKey.get(uniqueKey);
  if (existing) {
    stats.duplicates += 1;
    if (JSON.stringify([candidate.input, candidate.output, candidate.cacheWrite, candidate.cacheRead]) !==
        JSON.stringify([existing.input, existing.output, existing.cacheWrite, existing.cacheRead])) {
      stats.duplicateUsageDifferences += 1;
    }
    if (preferAssistantCandidate(existing, candidate)) session.assistantByKey.set(uniqueKey, candidate);
  } else {
    session.assistantByKey.set(uniqueKey, candidate);
  }

}

/**
 * Look for /clear and /compact commands written as <command-name> tags.
 * Only text that starts with a <command-...> tag counts, so a prompt that merely
 * quotes the tag is not mistaken for a command.
 */
function detectCommands(text, ts, session, state) {
  if (typeof text !== 'string' || ts === null) return;
  if (!/^\s*<command-(name|message)>/.test(text)) return;
  const match = /<command-name>\s*\/?([A-Za-z0-9_-]+)\s*<\/command-name>/.exec(text);
  if (!match) return;
  const name = match[1].toLowerCase();
  if (name === 'clear') {
    state.stats.clearCommands += 1;
    session.events.push({ ts: ts, kind: 'clear', auto: false, source: 'command', paired: false });
  } else if (name === 'compact') {
    state.stats.compactCommands += 1;
    session.events.push({ ts: ts, kind: 'compact', auto: false, source: 'command', paired: false });
  }
}

/**
 * A line flagged isCompactSummary holds the summary that replaces the context.
 * If a /compact command came right before it, both are the same (manual) event;
 * otherwise Claude Code compacted on its own (automatic compaction).
 */
function registerCompactSummary(session, ts, state) {
  state.stats.compactSummaryFlags += 1;
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const ev = session.events[i];
    if (ev.kind === 'compact' && ev.source === 'command' && !ev.paired &&
        ts !== null && ts >= ev.ts && ts - ev.ts <= COMPACT_PAIR_WINDOW_MS) {
      ev.paired = true;
      return;
    }
  }
  if (ts === null) return;
  state.stats.autoCompact += 1;
  session.events.push({ ts: ts, kind: 'compact', auto: true, source: 'summaryFlag', paired: true });
}

/** Characters (not tokens) in a tool_result's content, which can be a string or a list of blocks. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (part) {
      if (typeof part === 'string') return part;
      return isObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    }).join('\n');
  }
  return '';
}

/** First few non-empty lines of a text, trimmed, without terminal colour codes. */
function previewLines(text) {
  const lines = [];
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length && lines.length < 3; i += 1) {
    const clean = all[i].replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (clean) lines.push(clean.length > 160 ? clean.slice(0, 160) + '…' : clean);
  }
  return lines;
}

/** Find tool_result blocks inside a user message and keep the big ones. */
function extractToolResults(content, ts, session, state) {
  content.forEach(function (block) {
    if (!isObject(block) || block.type !== 'tool_result') return;
    state.stats.toolResults += 1;
    const text = toolResultText(block.content);
    const chars = text.length;
    if (chars < state.options.keepToolResultsAbove) return;
    session.toolResults.push({
      ts: ts,
      chars: chars,
      tool: typeof block.tool_use_id === 'string' ? state.toolNames.get(block.tool_use_id) || null : null,
      preview: previewLines(text)
    });
  });
}

/** User line: commands, compaction summaries and tool results. */
function handleUser(obj, ts, file, state, seq) {
  const session = resolveSession(obj, file, state);
  touch(session, ts);

  const message = isObject(obj.message) ? obj.message : null;
  const content = message ? message.content : null;
  const dedup = userDedupKey(obj, message);
  if (dedup && session.userMessageIds.has(dedup)) return;
  if (dedup) session.userMessageIds.add(dedup);
  rememberActivity(session, 'user:' + (dedup || 'line:' + seq), ts, seq, 'user');
  const title = userTitle(content);
  if (title && (!session.firstUserTitle || seq < session.firstUserTitleSeq)) {
    session.firstUserTitle = title;
    session.firstUserTitleSeq = seq;
  }

  if (obj.isCompactSummary === true) registerCompactSummary(session, ts, state);
  if (typeof content === 'string') {
    detectCommands(content, ts, session, state);
  } else if (Array.isArray(content)) {
    content.forEach(function (block) {
      if (isObject(block) && block.type === 'text') detectCommands(block.text, ts, session, state);
    });
    extractToolResults(content, ts, session, state);
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function createState(options) {
  return {
    options: {
      // Tool results shorter than this are counted but not stored.
      keepToolResultsAbove: options && typeof options.keepToolResultsAbove === 'number' ? options.keepToolResultsAbove : Infinity
    },
    sessions: new Map(),
    stats: {
      files: 0,
      filesUnreadable: 0,
      lines: 0,
      ignored: 0,
      malformed: 0,
      types: {},
      usageFields: {},
      fieldPresence: {},
      assistantLines: 0,
      assistantNoUsage: 0,
      assistantZeroUsage: 0,
      assistantNoTimestamp: 0,
      invalidTimestamps: 0,
      usageObjects: 0,
      uniqueResponses: 0,
      sidechainResponses: 0,
      duplicates: 0,
      duplicateUsageDifferences: 0,
      synthetic: 0,
      noDedupKey: 0,
      toolResults: 0,
      clearCommands: 0,
      compactCommands: 0,
      compactSummaryFlags: 0,
      autoCompact: 0,
      summaryLines: 0
    },
    sequence: 0,
    parentSessions: new Map(),
    toolNames: new Map()
  };
}

function handleObject(obj, file, state) {
  const type = typeof obj.type === 'string' ? obj.type : '(none)';
  bump(state.stats.types, type);
  const seq = state.sequence;
  state.sequence += 1;
  const ts = readTimestamp(obj);
  if ((typeof obj.timestamp === 'string' || typeof obj.timestamp === 'number') && ts === null) {
    state.stats.invalidTimestamps += 1;
  }
  if (ts !== null) file.lastTs = ts;

  if (type === 'assistant') {
    handleAssistant(obj, ts, file, state, seq);
  } else if (type === 'user') {
    handleUser(obj, ts, file, state, seq);
  } else if (type === 'ai-title') {
    const title = typeof obj.aiTitle === 'string' ? obj.aiTitle.trim() : '';
    if (title && typeof obj.sessionId === 'string' && obj.sessionId) {
      const session = resolveSession(obj, file, state);
      session.aiTitle = title.slice(0, 500);
    }
  } else if (type === 'summary') {
    state.stats.summaryLines += 1;
    if (file.lastSession) file.lastSession.summaryMarkers += 1;
  }
}

async function parseFile(fileInfo, state) {
  const folder = path.basename(path.dirname(fileInfo.path));
  const file = {
    path: fileInfo.path,
    folder: folder,
    sessionFallback: path.basename(fileInfo.path).replace(/\.jsonl$/i, ''),
    lastTs: null,
    lastSession: null
  };
  state.stats.files += 1;

  let first = true;
  const rl = readline.createInterface({
    input: fs.createReadStream(fileInfo.path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  try {
    for await (const rawLine of rl) {
      let line = rawLine;
      if (first) {
        line = line.replace(/^\uFEFF/, '');
        first = false;
      }
      if (!line.trim()) continue;
      state.stats.lines += 1;
      const obj = parseLine(line);
      if (obj === null) {
        state.stats.ignored += 1;
        state.stats.malformed += 1;
        continue;
      }
      try {
        handleObject(obj, file, state);
      } catch (e) {
        // A line with an unexpected shape must never stop the whole read.
        state.stats.ignored += 1;
      }
    }
  } catch (e) {
    state.stats.filesUnreadable += 1;
  }
}

/**
 * Parse a list of files (from listJsonlFiles).
 * options.keepToolResultsAbove: store tool results longer than this many characters.
 * Returns { sessions: [...], stats: {...} }.
 */
async function parseFiles(files, options) {
  const state = createState(options);
  for (let i = 0; i < files.length; i += 1) {
    await parseFile(files[i], state);
  }
  const sessions = Array.from(state.sessions.values());
  sessions.forEach(function (session) {
    const responses = Array.from(session.assistantByKey.values());
    session.assistantMessageCount = responses.length;
    session.turns = responses.filter(function (turn) { return turn.usageValid; });
    state.stats.uniqueResponses += session.turns.length;
    state.stats.sidechainResponses += session.turns.filter(function (turn) { return turn.sidechain; }).length;
    session.messages = Array.from(session.activityByKey.values());
    session.messages.sort(function (a, b) { return a.ts - b.ts || a.seq - b.seq; });
    delete session.assistantByKey;
    delete session.userMessageIds;
    delete session.activityByKey;
    delete session.firstUserTitleSeq;
  });
  return { sessions: sessions, stats: state.stats };
}

module.exports = {
  EXPECTED_USAGE_FIELDS: EXPECTED_USAGE_FIELDS,
  TRACKED_FIELDS: TRACKED_FIELDS,
  listJsonlFiles: listJsonlFiles,
  parseFiles: parseFiles
};
