#!/usr/bin/env node
'use strict';

/**
 * bin/cli.js
 *
 * Entry point. Reads the command-line arguments and starts either the dashboard
 * or the parser check.
 *
 *   --example        use the made-up files in example/
 *   --check          print the parser report in the terminal and exit
 *   --data <path>    read .jsonl files from this folder
 *   --lang <es|en>   language of the terminal output
 *   --no-open        do not open the browser automatically
 *   --help, --version
 *
 * The first lines of this file avoid modern JavaScript syntax on purpose, so an
 * old Node.js version can still print the "please update Node" message.
 */

var i18n = require('../src/i18n');

var REQUIRED_NODE_MAJOR = 18;

/** Parse process.argv into a plain object. Returns { error: { key, params } } on bad input. */
function parseArgs(argv) {
  var args = { example: false, check: false, data: null, lang: null, noOpen: false, help: false, version: false };
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    var name = arg;
    var inline = null;
    var eq = arg.indexOf('=');
    if (arg.indexOf('--') === 0 && eq > 0) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }

    if (name === '--example') args.example = true;
    else if (name === '--check') args.check = true;
    else if (name === '--no-open') args.noOpen = true;
    else if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--version' || name === '-v') args.version = true;
    else if (name === '--data' || name === '--lang') {
      var value = inline !== null ? inline : argv[i + 1];
      if (inline === null) i += 1;
      if (value === undefined || value === '' || (inline === null && value.indexOf('--') === 0)) {
        return { error: { key: 'cli.missingValue', params: { arg: name } } };
      }
      if (name === '--data') {
        args.data = value;
      } else {
        if (!i18n.isSupported(value)) {
          return { error: { key: 'cli.badLang', params: { value: value, langs: i18n.SUPPORTED.join(', ') } } };
        }
        args.lang = value;
      }
    } else {
      return { error: { key: 'cli.unknownArg', params: { arg: arg } } };
    }
  }
  return args;
}

/** Language used before the config file is read (needed for early error messages). */
function earlyLang(argv) {
  var idx = argv.indexOf('--lang');
  var fromArg = idx !== -1 ? argv[idx + 1] : null;
  if (!fromArg) {
    for (var i = 0; i < argv.length; i += 1) {
      if (argv[i].indexOf('--lang=') === 0) fromArg = argv[i].slice(7);
    }
  }
  return i18n.detectLang({ arg: fromArg });
}

var rawArgs = process.argv.slice(2);
var major = parseInt(process.versions.node.split('.')[0], 10);

if (major < REQUIRED_NODE_MAJOR) {
  console.error(i18n.t(earlyLang(rawArgs), 'cli.nodeTooOld', {
    required: REQUIRED_NODE_MAJOR,
    found: process.versions.node
  }));
  process.exit(1);
}

var args = parseArgs(rawArgs);
if (args.error) {
  var lang0 = earlyLang(rawArgs);
  console.error(i18n.t(lang0, args.error.key, args.error.params));
  console.error(i18n.t(lang0, 'cli.helpHint'));
  process.exit(1);
}

// From here on modern syntax is fine: Node 18 or newer is running.
require('../src/main').main(args).then(function (code) {
  if (typeof code === 'number') process.exitCode = code;
}).catch(function (err) {
  var lang = earlyLang(rawArgs);
  console.error(i18n.t(lang, 'cli.fatal', { message: err && err.message ? err.message : String(err) }));
  process.exit(1);
});
