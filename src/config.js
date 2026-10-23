'use strict';

/**
 * config.js
 *
 * Everything related to settings and paths lives here:
 *  - DEFAULTS: the default thresholds used by the diagnostics.
 *  - loadUserConfig(): merges an optional config.json from the user's own
 *    folder (~/.claude-token-dashboard/) on top of the defaults.
 *  - Path helpers, including isInside(), the guard used everywhere to make
 *    sure the tool never reads or writes outside the folders it is allowed to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Absolute path of the repository root (the folder that contains package.json). */
const ROOT = path.resolve(__dirname, '..');

/** Folder (inside the user's home) where history.json and config.json live. */
const APP_DIR_NAME = '.claude-token-dashboard';

/** Gaps longer than this are excluded when calculating active session time. */
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** Prompt-cache lifetime used by the resumed-session diagnostic. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Require at least this cache write and this share of the previous context for a resume warning. */
const RESUMED_CACHE_MIN_TOKENS = 20000;
const RESUMED_CACHE_CONTEXT_RATIO = 0.8;

/** Approximate published Anthropic input-price ratios; review https://www.anthropic.com/pricing. */
const TOKEN_WEIGHTS = Object.freeze({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });

/**
 * Default settings. To change them for yourself without touching the code,
 * create ~/.claude-token-dashboard/config.json with only the keys you want
 * to override, for example:
 *
 *   { "lang": "es", "thresholds": { "longSession": { "contextTokens": 150000 } } }
 */
const DEFAULTS = {
  // Default dashboard language: null (use the browser), "es" or "en".
  lang: null,

  thresholds: {
    // A stretch of work without /clear or /compact is "too long" when the
    // context exceeds contextTokens OR it lasts more than `turns` turns.
    longSession: { contextTokens: 100000, turns: 60 },

    // Anthropic's prompt cache expires after about 5 minutes. If the gap
    // between two turns is longer than gapSeconds and the next turn writes
    // more than cacheWriteTokens of cache, the cache was lost.
    cacheMiss: { gapSeconds: CACHE_TTL_MS / 1000, cacheWriteTokens: RESUMED_CACHE_MIN_TOKENS },

    // A single tool_result longer than this many characters is "huge".
    hugeToolResult: { chars: 20000 },

    // Turns on an expensive model (matched by modelPattern, case-insensitive)
    // whose output is shorter than shortOutputTokens count as "simple".
    // The diagnostic appears when there are at least minShortTurns of them
    // and they are at least minShortShare (0 to 1) of the expensive turns.
    expensiveModel: {
      modelPattern: 'opus',
      shortOutputTokens: 150,
      minShortTurns: 5,
      minShortShare: 0.5
    },

    // Subagent usage is reported when a session spent at least this many tokens there.
    subagents: { minTokens: 20000 },

    // Gaps longer than this are drawn as "pause" markers in the session chart.
    pause: { gapSeconds: CACHE_TTL_MS / 1000 },

    // A jump in context larger than this between two turns is drawn as a "spike".
    spike: { minIncreaseTokens: 30000 }
  },

  // Relative price weights apply equally to every model; they are not a cost estimate.
  weights: TOKEN_WEIGHTS
};

/** App folder: CLAUDE_TOKEN_DASHBOARD_HOME (mostly for tests) or ~/.claude-token-dashboard. */
function appDirFromEnv(env) {
  const custom = env && env.CLAUDE_TOKEN_DASHBOARD_HOME;
  return custom ? path.resolve(custom) : path.join(os.homedir(), APP_DIR_NAME);
}

/** Folder where the tool is allowed to write (history.json) and read config.json. */
function getAppDir(env) {
  return appDirFromEnv(env || process.env);
}

/** Where Claude Code keeps its transcripts: ~/.claude/projects (%USERPROFILE%\.claude\projects on Windows). */
function getDefaultDataDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Decide which folder to read. Priority: example mode, --data, CLAUDE_DATA_DIR, default.
 */
function resolveDataDir(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (opts.example) return path.join(ROOT, 'example');
  if (opts.dataArg) return path.resolve(process.cwd(), opts.dataArg);
  if (env.CLAUDE_DATA_DIR) return path.resolve(process.cwd(), env.CLAUDE_DATA_DIR);
  return getDefaultDataDir();
}

/**
 * True when `target` is `root` itself or lives inside it.
 * Both paths are resolved first, so "../" tricks are normalized away.
 */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(rel);
}

/** Throws if `target` is not inside any of the allowed `roots`. */
function assertInside(roots, target) {
  const list = Array.isArray(roots) ? roots : [roots];
  for (let i = 0; i < list.length; i += 1) {
    if (isInside(list[i], target)) return path.resolve(target);
  }
  const err = new Error('Path is outside the allowed folders');
  err.code = 'EOUTSIDE';
  throw err;
}

/** Replace the home folder with "~" so printed paths are safe to share. */
function displayPath(p) {
  const home = os.homedir();
  if (home && isInside(home, p)) {
    const rel = path.relative(home, p);
    return rel ? path.join('~', rel) : '~';
  }
  return p;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Copy valid values from `user` into `target` (which starts as a copy of the
 * defaults). Invalid or unknown entries are skipped and reported in `warnings`.
 */
function mergeInto(target, defaults, user, prefix, warnings, file) {
  Object.keys(user).forEach(function (key) {
    const fullKey = prefix ? prefix + '.' + key : key;
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      warnings.push({ code: 'configUnknownKey', params: { key: fullKey, file: file } });
      return;
    }
    const def = defaults[key];
    const val = user[key];
    if (isPlainObject(def)) {
      if (!isPlainObject(val)) {
        warnings.push({ code: 'configBadValue', params: { key: fullKey, file: file } });
        return;
      }
      mergeInto(target[key], def, val, fullKey, warnings, file);
      return;
    }
    let ok = false;
    if (key === 'lang') {
      ok = val === null || val === 'es' || val === 'en' || (typeof val === 'string' && /^[a-z]{2}$/.test(val));
    } else if (key === 'modelPattern') {
      if (typeof val === 'string' && val.length > 0 && val.length < 100) {
        try { new RegExp(val, 'i'); ok = true; } catch (e) { ok = false; }
      }
    } else if (typeof def === 'number') {
      ok = typeof val === 'number' && isFinite(val) && val >= 0;
    }
    if (ok) target[key] = val;
    else warnings.push({ code: 'configBadValue', params: { key: fullKey, file: file } });
  });
}

/**
 * Build the effective configuration.
 * Returns { config, warnings } where warnings are { code, params } objects
 * that the caller translates (nothing here is user-facing text).
 */
function loadUserConfig(appDir) {
  const config = clone(DEFAULTS);
  const warnings = [];
  const file = path.join(appDir, 'config.json');
  let raw = null;
  try {
    assertInside(appDir, file);
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { config: config, warnings: warnings, file: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    warnings.push({ code: 'configInvalidJson', params: { file: displayPath(file) } });
    return { config: config, warnings: warnings, file: file };
  }
  if (!isPlainObject(parsed)) {
    warnings.push({ code: 'configInvalidJson', params: { file: displayPath(file) } });
    return { config: config, warnings: warnings, file: file };
  }
  mergeInto(config, DEFAULTS, parsed, '', warnings, displayPath(file));
  return { config: config, warnings: warnings, file: file };
}

module.exports = {
  ROOT: ROOT,
  APP_DIR_NAME: APP_DIR_NAME,
  IDLE_THRESHOLD_MS: IDLE_THRESHOLD_MS,
  CACHE_TTL_MS: CACHE_TTL_MS,
  RESUMED_CACHE_MIN_TOKENS: RESUMED_CACHE_MIN_TOKENS,
  RESUMED_CACHE_CONTEXT_RATIO: RESUMED_CACHE_CONTEXT_RATIO,
  TOKEN_WEIGHTS: TOKEN_WEIGHTS,
  DEFAULTS: DEFAULTS,
  getAppDir: getAppDir,
  getDefaultDataDir: getDefaultDataDir,
  resolveDataDir: resolveDataDir,
  isInside: isInside,
  assertInside: assertInside,
  displayPath: displayPath,
  loadUserConfig: loadUserConfig
};
