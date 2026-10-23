'use strict';

/**
 * main.js
 *
 * The program flow behind bin/cli.js: load settings, pick the language, then
 * either print the parser check or start the dashboard server.
 * All text shown in the terminal comes from src/i18n/*.json.
 */

const config = require('./config');
const i18n = require('./i18n');
const parser = require('./parser');
const pkg = require('../package.json');

const DEFAULT_PORT = 4747;

/** PORT environment variable as a number, or an error value. */
function readPort(env) {
  if (env.PORT === undefined || env.PORT === '') return { port: DEFAULT_PORT };
  if (!/^\d+$/.test(env.PORT)) return { error: env.PORT };
  const port = parseInt(env.PORT, 10);
  if (port < 1 || port > 65535) return { error: env.PORT };
  return { port: port };
}

/**
 * Run the program with the parsed arguments.
 * Resolves to an exit code, or undefined when the server keeps running.
 */
async function main(args) {
  const appDir = config.getAppDir();
  const loaded = config.loadUserConfig(appDir);
  const lang = i18n.detectLang({ arg: args.lang, configLang: loaded.config.lang });
  const t = function (key, params) { return i18n.t(lang, key, params); };

  if (args.help) {
    console.log(t('cli.help'));
    return 0;
  }
  if (args.version) {
    console.log(pkg.version);
    return 0;
  }

  const dataDir = config.resolveDataDir({ example: args.example, dataArg: args.data });

  if (args.check) {
    return require('./check').runCheck({ dataDir: dataDir, lang: lang });
  }

  const portInfo = readPort(process.env);
  if (portInfo.error !== undefined) {
    console.error(t('cli.portInvalid', { value: portInfo.error }));
    return 1;
  }

  console.log(t('cli.title', { version: pkg.version }));
  loaded.warnings.forEach(function (w) {
    console.warn(t('warn.' + w.code, w.params));
  });

  if (args.example) {
    console.log(t('cli.example'));
  } else {
    console.log(t('cli.reading', { dir: config.displayPath(dataDir) }));
    const found = parser.listJsonlFiles(dataDir);
    if (!found.exists) console.warn(t('cli.dataMissing', { dir: config.displayPath(dataDir) }));
    else if (found.files.length === 0) console.warn(t('cli.dataEmpty', { dir: config.displayPath(dataDir) }));
  }

  const ctx = {
    example: args.example,
    dataDir: dataDir,
    appDir: appDir,
    config: loaded.config,
    configWarnings: loaded.warnings,
    defaultLang: loaded.config.lang
  };

  let running;
  try {
    running = await require('./server').startServer({ ctx: ctx, port: portInfo.port });
  } catch (err) {
    if (err && err.code === 'ENOPORT') {
      console.error(t('cli.noPort', { port: portInfo.port }));
    } else {
      console.error(t('cli.fatal', { message: err && err.message ? err.message : String(err) }));
    }
    return 1;
  }

  if (running.port !== running.requestedPort) {
    console.log(t('cli.portBusy', { requested: String(running.requestedPort), port: String(running.port) }));
  }
  console.log(t('cli.dashboardUrl', { url: running.url }));
  console.log(t('cli.stop'));

  process.on('SIGINT', function () {
    console.log('\n' + t('cli.shutdown'));
    process.exit(0);
  });

  if (!args.noOpen) {
    const opened = await require('./browser').openBrowser(running.url);
    if (!opened) console.log(t('cli.browserFailed', { url: running.url }));
  }
  return undefined;
}

module.exports = { main: main };
