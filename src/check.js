'use strict';

/**
 * check.js  (npm run check)
 *
 * Because the .jsonl format is not officially documented, this command reads
 * the real files and reports whether the parser understands them.
 *
 * The report contains ONLY counts and field names: no prompts, no code, no
 * tool output, no file names. It is safe to paste into an issue. The only path
 * printed is the data folder, with the home directory shortened to "~".
 */

const parser = require('./parser');
const i18n = require('./i18n');
const { displayPath } = require('./config');

/**
 * Where to look when a field is missing. The names are functions in src/parser.js.
 */
const FIELD_OWNER = {
  timestamp: 'readTimestamp',
  sessionId: 'resolveSession',
  cwd: 'resolveSession',
  isSidechain: 'handleAssistant',
  requestId: 'dedupKey',
  'message.id': 'dedupKey',
  'message.model': 'handleAssistant'
};

function sortedEntries(map) {
  return Object.keys(map)
    .map(function (key) { return [key, map[key]]; })
    .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Run the check and print the report.
 * options = { dataDir, lang }. Returns the exit code (0 = ran fine, 1 = nothing to read).
 */
async function runCheck(options) {
  const lang = options.lang;
  const t = function (key, params) { return i18n.t(lang, key, params); };
  const n = function (value) { return i18n.number(lang, value); };
  const out = [];
  const warnings = [];

  out.push(t('check.title'));
  out.push(t('check.safeNote'));
  out.push('');
  out.push(t('check.source', { dir: displayPath(options.dataDir) }));

  const found = parser.listJsonlFiles(options.dataDir);
  if (!found.exists) {
    out.push('');
    out.push(t('check.warn.noDir', { dir: displayPath(options.dataDir) }));
    out.push(t('check.hint.data'));
    console.log(out.join('\n'));
    return 1;
  }
  if (found.files.length === 0) {
    out.push('');
    out.push(t('check.warn.noFiles'));
    out.push(t('check.hint.data'));
    console.log(out.join('\n'));
    return 1;
  }

  // Tool results are only counted here, never stored.
  const parsed = await parser.parseFiles(found.files, { keepToolResultsAbove: Infinity });
  const s = parsed.stats;
  const sessionsWithTurns = parsed.sessions.filter(function (x) { return x.turns.length > 0; }).length;

  out.push(t('check.files', { files: s.files }));
  out.push(t('check.lines', { lines: s.lines }));
  out.push(t('check.ignored', { ignored: s.ignored }));

  // Line types
  out.push('');
  out.push(t('check.types.title'));
  sortedEntries(s.types).forEach(function (entry) {
    out.push('  ' + pad(entry[0], 26) + n(entry[1]));
  });

  // Usage fields
  out.push('');
  out.push(t('check.usage.title'));
  const usageEntries = sortedEntries(s.usageFields);
  if (usageEntries.length === 0) out.push('  ' + t('check.none'));
  usageEntries.forEach(function (entry) {
    const expected = parser.EXPECTED_USAGE_FIELDS.indexOf(entry[0]) !== -1;
    out.push('  ' + pad(entry[0], 34) + pad(n(entry[1]), 10) + (expected ? t('check.usage.expected') : t('check.usage.extra')));
  });

  // Fields on assistant lines
  out.push('');
  out.push(t('check.fields.title'));
  parser.TRACKED_FIELDS.forEach(function (field) {
    const have = s.fieldPresence[field] || 0;
    out.push('  ' + pad(field, 20) + n(have) + ' / ' + n(s.assistantLines));
  });

  // Commands and compactions
  out.push('');
  out.push(t('check.commands.title'));
  out.push('  ' + t('check.commands.clear', { count: s.clearCommands }));
  out.push('  ' + t('check.commands.compact', { count: s.compactCommands }));
  out.push('  ' + t('check.commands.auto', { count: s.autoCompact }));
  out.push('  ' + t('check.commands.summaryFlag', { count: s.compactSummaryFlags }));
  out.push('  ' + t('check.commands.summaryLines', { count: s.summaryLines }));

  // Totals
  out.push('');
  out.push(t('check.totals.title'));
  out.push('  ' + t('check.totals.responses', { count: s.uniqueResponses }));
  out.push('  ' + t('check.totals.duplicates', { count: s.duplicates }));
  out.push('  ' + t('check.totals.sidechain', { count: s.sidechainResponses }));
  out.push('  ' + t('check.totals.sessions', { count: sessionsWithTurns }));
  out.push('  ' + t('check.totals.toolResults', { count: s.toolResults }));

  // Warnings
  if (s.ignored > 0) {
    warnings.push(t('check.warn.ignoredLines', { ignored: s.ignored, lines: s.lines }));
  }
  if ((s.types.assistant || 0) === 0) {
    warnings.push(t('check.warn.noAssistant'));
  } else {
    if (usageEntries.length === 0) {
      warnings.push(t('check.warn.noUsage'));
    } else {
      parser.EXPECTED_USAGE_FIELDS.forEach(function (field) {
        if (!s.usageFields[field]) warnings.push(t('check.warn.usageField', { field: field }));
      });
    }
    if (s.assistantNoTimestamp > 0) {
      warnings.push(t('check.warn.noTimestamp', { count: s.assistantNoTimestamp }));
    }
    if (s.noDedupKey > 0) {
      warnings.push(t('check.warn.noDedupKey', { count: s.noDedupKey }));
    }
    parser.TRACKED_FIELDS.forEach(function (field) {
      const have = s.fieldPresence[field] || 0;
      if (field !== 'timestamp' && field !== 'requestId' && have < s.assistantLines) {
        warnings.push(t('check.warn.fieldMissing', {
          field: field,
          count: s.assistantLines - have,
          total: s.assistantLines,
          where: FIELD_OWNER[field]
        }));
      }
    });
  }
  if (s.toolResults === 0) warnings.push(t('check.warn.noToolResults'));
  if (s.clearCommands + s.compactCommands + s.compactSummaryFlags + s.summaryLines === 0) {
    warnings.push(t('check.warn.noCommands'));
  }

  out.push('');
  if (warnings.length === 0) {
    out.push(t('check.verdict.ok'));
  } else {
    out.push(t('check.verdict.warn', { count: warnings.length }));
    warnings.forEach(function (w) { out.push('  ! ' + w); });
  }

  console.log(out.join('\n'));
  return 0;
}

module.exports = { runCheck: runCheck };
