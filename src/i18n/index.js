'use strict';

/**
 * i18n/index.js
 *
 * Tiny translation helper shared by the terminal output and the server.
 * The translations themselves live in en.json and es.json in this folder;
 * the browser downloads those same files.
 *
 * This file avoids modern syntax on purpose, so it can still be loaded by an
 * old Node.js version to print the "please update Node" message.
 *
 * To add a language: copy en.json to <code>.json, translate every value
 * (keep the keys and the {placeholders}), add a "lang.<code>" entry to every
 * file, and add the code to SUPPORTED below.
 */

var fs = require('fs');
var path = require('path');

/** Language codes that have a translation file. The first one is the fallback. */
var SUPPORTED = ['en', 'es'];
var FALLBACK = 'en';

var cache = {};

/** Folder that contains the translation files. */
var I18N_DIR = __dirname;

function isSupported(lang) {
  return typeof lang === 'string' && SUPPORTED.indexOf(lang) !== -1;
}

/** Load (and cache) the translation table of a language. */
function load(lang) {
  var code = isSupported(lang) ? lang : FALLBACK;
  if (!cache[code]) {
    cache[code] = JSON.parse(fs.readFileSync(path.join(I18N_DIR, code + '.json'), 'utf8'));
  }
  return cache[code];
}

/** "es-ES", "es_MX.UTF-8" and "ES" all map to "es"; unknown or empty locales map to the fallback. */
function langFromLocale(locale) {
  if (typeof locale !== 'string') return null;
  var code = locale.trim().toLowerCase().slice(0, 2);
  return isSupported(code) ? code : FALLBACK;
}

/**
 * Terminal language. Priority:
 *   1. --lang (options.arg)
 *   2. "lang" in config.json (options.configLang)
 *   3. system locale: LC_ALL, LC_MESSAGES, LANG, LANGUAGE, then Intl
 */
function detectLang(options) {
  var opts = options || {};
  if (isSupported(opts.arg)) return opts.arg;
  if (isSupported(opts.configLang)) return opts.configLang;
  var env = opts.env || process.env;
  var names = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'];
  for (var i = 0; i < names.length; i += 1) {
    var value = env[names[i]];
    if (value && value !== 'C' && value !== 'POSIX' && value.indexOf('C.') !== 0) {
      return langFromLocale(value.split(':')[0]) || FALLBACK;
    }
  }
  try {
    var intlLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return langFromLocale(intlLocale) || FALLBACK;
  } catch (e) {
    return FALLBACK;
  }
}

var PLURAL_RE = /\{(\w+),\s*plural,\s*((?:(?:zero|one|two|few|many|other)\s*\{[^{}]*\}\s*)+)\}/g;

function formatNumber(n, lang) {
  var digits = Math.floor(n) === n ? 0 : 1;
  return new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(n);
}

/**
 * Fill a template:
 *   {name}                         -> the parameter (numbers use the language's format)
 *   {n, plural, one {# x} other {# xs}} -> picks the right plural form, # is the number
 */
function format(template, params, lang) {
  var p = params || {};
  var out = String(template).replace(PLURAL_RE, function (match, name, body) {
    var n = Number(p[name]);
    var rule = 'other';
    try { rule = isFinite(n) ? new Intl.PluralRules(lang).select(n) : 'other'; } catch (e) { rule = 'other'; }
    var options = {};
    body.replace(/(\w+)\s*\{([^{}]*)\}/g, function (m, key, text) {
      options[key] = text;
      return '';
    });
    var chosen = options[rule] !== undefined ? options[rule] : options.other;
    return String(chosen === undefined ? '' : chosen).replace(/#/g, isFinite(n) ? formatNumber(n, lang) : '');
  });
  return out.replace(/\{(\w+)\}/g, function (match, name) {
    if (!Object.prototype.hasOwnProperty.call(p, name)) return match;
    var v = p[name];
    if (typeof v === 'number' && isFinite(v)) return formatNumber(v, lang);
    return v === null || v === undefined ? '' : String(v);
  });
}

/** Translate a key. Falls back to English, then to the key itself. */
function t(lang, key, params) {
  var table = load(lang);
  var template = table[key];
  if (template === undefined) template = load(FALLBACK)[key];
  if (template === undefined) return key;
  return format(template, params, isSupported(lang) ? lang : FALLBACK);
}

/** Format an integer or decimal with the language's conventions. */
function number(lang, n) {
  return isFinite(n) ? formatNumber(n, isSupported(lang) ? lang : FALLBACK) : '';
}

module.exports = {
  SUPPORTED: SUPPORTED,
  FALLBACK: FALLBACK,
  I18N_DIR: I18N_DIR,
  isSupported: isSupported,
  load: load,
  detectLang: detectLang,
  langFromLocale: langFromLocale,
  format: format,
  t: t,
  number: number
};
