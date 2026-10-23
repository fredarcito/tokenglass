'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const parser = require('../src/parser');
const data = require('../src/data');
const config = require('../src/config');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session' || argv[i] === '--data' || argv[i] === '--project' || argv[i] === '--lang') {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error('Unknown argument: ' + argv[i]);
    }
  }
  return out;
}

function timestamp(value) {
  const ms = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function rawUsage(usage) {
  const cacheWrite = usage.cache_creation_input_tokens === undefined && usage.cache_creation &&
      typeof usage.cache_creation === 'object'
    ? Object.keys(usage.cache_creation).reduce((sum, key) => sum + positive(usage.cache_creation[key]), 0)
    : positive(usage.cache_creation_input_tokens);
  return {
    input: positive(usage.input_tokens),
    output: positive(usage.output_tokens),
    cacheWrite: cacheWrite,
    cacheRead: positive(usage.cache_read_input_tokens)
  };
}

function keyForAssistant(obj, message) {
  if (message && typeof message.id === 'string' && message.id) return 'message:' + message.id;
  if (typeof obj.requestId === 'string' && obj.requestId) return 'request:' + obj.requestId;
  if (typeof obj.uuid === 'string' && obj.uuid) return 'uuid:' + obj.uuid;
  return 'line:' + obj.__verifySequence;
}

function userKey(obj, message) {
  if (typeof obj.uuid === 'string' && obj.uuid) return 'uuid:' + obj.uuid;
  if (message && typeof message.id === 'string' && message.id) return 'message:' + message.id;
  return null;
}

function firstUserLabel(content) {
  const texts = typeof content === 'string' ? [content] : Array.isArray(content)
    ? content.filter((part) => part && part.type === 'text').map((part) => part.text) : [];
  for (const value of texts) {
    if (typeof value !== 'string') continue;
    let text = value.trim();
    if (!text || /^\/[a-z][\w-]*(?:\s|$)/i.test(text)) continue;
    if (/^<(?:command-|local-command|system-reminder|task-notification|antml:|function_results|environment_context|ide_)/i.test(text)) continue;
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
    if (text) return text.slice(0, 500);
  }
  return '';
}

function remember(map, key, ts, seq, kind) {
  if (ts === null) return;
  const existing = map.get(key);
  if (!existing || ts < existing.ts) map.set(key, { ts: ts, seq: seq, kind: kind });
}

function prefer(existing, candidate) {
  return !existing || candidate.tokens.output > existing.tokens.output ||
    (candidate.tokens.output === existing.tokens.output && candidate.seq >= existing.seq);
}

async function readRaw(files, sessionId) {
  const assistant = new Map();
  const activity = new Map();
  const messageIds = new Set();
  let assistantLines = 0;
  let aiTitle = '';
  let firstUserTitle = '';
  let seq = 0;

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file.path, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    let firstLine = true;
    for await (const rawLine of rl) {
      const line = firstLine ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      firstLine = false;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { seq += 1; continue; }
      const current = seq++;
      if (!obj || typeof obj !== 'object' || obj.sessionId !== sessionId) continue;
      const ts = timestamp(obj.timestamp);
      if (obj.type === 'ai-title') {
        if (typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) aiTitle = obj.aiTitle.trim();
      } else if (obj.type === 'assistant') {
        assistantLines += 1;
        const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
        if (typeof message.id === 'string' && message.id) messageIds.add(message.id);
        const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
        const tokens = usage ? rawUsage(usage) : { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        const key = keyForAssistant(Object.assign({ __verifySequence: current }, obj), message);
        const candidate = {
          seq: current,
          ts: ts,
          model: message.model || 'unknown',
          sidechain: obj.isSidechain === true,
          usagePresent: Boolean(usage),
          tokens: tokens
        };
        const previous = assistant.get(key);
        if (prefer(previous, candidate)) assistant.set(key, candidate);
        remember(activity, 'assistant:' + key, ts, current, 'assistant');
      } else if (obj.type === 'user') {
        const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
        const key = userKey(obj, message) || 'line:' + current;
        remember(activity, 'user:' + key, ts, current, 'user');
        if (!firstUserTitle) firstUserTitle = firstUserLabel(message.content);
      }
    }
  }

  const all = Array.from(assistant.values());
  const valid = all.filter((turn) => turn.usagePresent && turn.model !== '<synthetic>' &&
    turn.tokens.input + turn.tokens.output + turn.tokens.cacheWrite + turn.tokens.cacheRead > 0);
  const main = valid.filter((turn) => !turn.sidechain).sort((a, b) => {
    if (a.ts === null || b.ts === null) return a.ts === b.ts ? a.seq - b.seq : (a.ts === null ? 1 : -1);
    return a.ts - b.ts || a.seq - b.seq;
  });
  const sums = valid.reduce((sum, turn) => {
    sum.input += turn.tokens.input;
    sum.cacheWrite += turn.tokens.cacheWrite;
    sum.cacheRead += turn.tokens.cacheRead;
    sum.output += turn.tokens.output;
    return sum;
  }, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  const first = main[0] || null;
  const messages = Array.from(activity.values()).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  let activeDurationMs = 0;
  for (let i = 1; i < messages.length; i += 1) {
    const gap = messages[i].ts - messages[i - 1].ts;
    if (gap > 0 && gap <= config.IDLE_THRESHOLD_MS) activeDurationMs += gap;
  }
  return {
    assistantLines: assistantLines,
    uniqueMessageIds: messageIds.size,
    validMainResponses: main.length,
    sums: sums,
    firstContext: first ? first.tokens.input + first.tokens.cacheWrite + first.tokens.cacheRead : null,
    activeDurationMs: activeDurationMs,
    spanMs: messages.length > 0 ? messages[messages.length - 1].ts - messages[0].ts : null,
    title: aiTitle || firstUserTitle
  };
}

function dashboardTotals(session) {
  return session.rows.reduce((sum, row) => {
    sum.input += row.i;
    sum.cacheWrite += row.cw;
    sum.cacheRead += row.cr;
    sum.output += row.o;
    return sum;
  }, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
}

function display(value) {
  if (value === null || value === undefined) return '—';
  return String(value);
}

function compare(label, expected, actual, text) {
  const same = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(expected - actual) < 1
    : expected === actual;
  return { label: label, expected: display(expected), actual: display(actual), status: same ? 'OK' : text.difference, same: same };
}

function printTable(rows, text) {
  const widths = [34, 20, 20, 12];
  const line = '+' + widths.map((width) => '-'.repeat(width + 2)).join('+') + '+';
  const render = (values) => '| ' + values.map((value, i) => String(value).slice(0, widths[i]).padEnd(widths[i])).join(' | ') + ' |';
  console.log(line);
  console.log(render([text.metric, text.expected, text.dashboard, text.status]));
  console.log(line);
  rows.forEach((row) => console.log(render([row.label, row.expected, row.actual, row.status])));
  console.log(line);
}

async function main() {
  const options = args(process.argv.slice(2));
  const lang = options.lang || (/^es\b/i.test(process.env.LANG || '') ? 'es' : 'en');
  if (lang !== 'es' && lang !== 'en') throw new Error('Language must be es or en.');
  const text = lang === 'es' ? {
    usage: 'Uso: npm run verify -- --session <id> [--project <nombre>] [--data <ruta>]',
    notFound: 'No se encontró la carpeta de datos: ',
    sessionMissing: 'No se encontró la sesión en los datos del dashboard: ',
    projectMismatch: 'El proyecto de la sesión no coincide con --project: ',
    session: 'Sesión',
    project: 'proyecto',
    metric: 'Métrica',
    expected: 'Esperado (JSONL)',
    dashboard: 'Dashboard',
    status: 'Estado',
    difference: 'DIFERENCIA'
  } : {
    usage: 'Usage: npm run verify -- --session <sessionId> [--project <name>] [--data <dir>]',
    notFound: 'Data directory not found: ',
    sessionMissing: 'Session not found in parsed dashboard data: ',
    projectMismatch: 'Session project does not match --project: ',
    session: 'Session',
    project: 'project',
    metric: 'Metric',
    expected: 'Expected (JSONL)',
    dashboard: 'Dashboard',
    status: 'Status',
    difference: 'DIFFERENCE'
  };
  if (!options.session) throw new Error(text.usage);
  const dataDir = options.data ? path.resolve(options.data) : config.getDefaultDataDir();
  const found = parser.listJsonlFiles(dataDir);
  if (!found.exists) throw new Error(text.notFound + dataDir);
  const raw = await readRaw(found.files, options.session);
  const parsed = await parser.parseFiles(found.files, { keepToolResultsAbove: config.DEFAULTS.thresholds.hugeToolResult.chars });
  const rawSession = parsed.sessions.find((session) => session.id === options.session);
  if (!rawSession) throw new Error(text.sessionMissing + options.session);
  const dashboard = data.buildSessions([rawSession], config.DEFAULTS)[0];
  if (options.project && !dashboard.project.toLowerCase().includes(options.project.toLowerCase())) {
    throw new Error(text.projectMismatch + dashboard.project);
  }
  const totals = dashboardTotals(dashboard);
  const rows = [
    compare(lang === 'es' ? 'Líneas assistant' : 'Assistant lines', raw.assistantLines, dashboard.assistantLines, text),
    compare(lang === 'es' ? 'message.id únicos assistant' : 'Unique assistant message.id', raw.uniqueMessageIds, dashboard.assistantMessageCount, text),
    compare(lang === 'es' ? 'Respuestas válidas principales' : 'Valid main assistant responses', raw.validMainResponses, dashboard.turns, text),
    compare(lang === 'es' ? 'Tokens de entrada' : 'Input tokens', raw.sums.input, totals.input, text),
    compare(lang === 'es' ? 'Tokens de creación de caché' : 'Cache creation tokens', raw.sums.cacheWrite, totals.cacheWrite, text),
    compare(lang === 'es' ? 'Tokens de lectura de caché' : 'Cache read tokens', raw.sums.cacheRead, totals.cacheRead, text),
    compare(lang === 'es' ? 'Tokens de salida' : 'Output tokens', raw.sums.output, totals.output, text),
    compare(lang === 'es' ? 'Baseline de contexto inicial' : 'First-turn context baseline', raw.firstContext, dashboard.firstContext, text),
    compare(lang === 'es' ? 'Duración activa (ms)' : 'Active duration (ms)', raw.activeDurationMs, dashboard.activeDurationMs, text),
    compare(lang === 'es' ? 'Lapso total (ms)' : 'Total span (ms)', raw.spanMs, dashboard.durationMs, text),
    compare(lang === 'es' ? 'Título de tarea' : 'Task title', raw.title, dashboard.title, text)
  ];
  console.log(text.session + ': ' + dashboard.id + ' · ' + text.project + ': ' + dashboard.project);
  printTable(rows, text);
  if (rows.some((row) => !row.same)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
