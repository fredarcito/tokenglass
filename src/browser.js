'use strict';

/**
 * browser.js
 *
 * Opens a URL in the default browser. This is the ONLY place where the tool
 * runs a system command, and the only arguments are a URL the tool built itself
 * (http://127.0.0.1:<port>/?token=<hex>).
 *
 *   macOS:   open <url>
 *   Linux:   xdg-open <url>
 *   Windows: cmd /c start "" <url>
 */

const { spawn } = require('child_process');

/** Resolves to true if the browser launcher ran successfully, false otherwise. */
function openBrowser(url) {
  return new Promise(function (resolve) {
    let command;
    let args;
    if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    let settled = false;
    function done(ok) {
      if (settled) return;
      settled = true;
      resolve(ok);
    }

    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', function () { done(false); });
      child.once('exit', function (code) { done(code === 0); });
      child.unref();
      // Some launchers keep running after opening the page: treat that as success.
      setTimeout(function () { done(true); }, 3000).unref();
    } catch (e) {
      done(false);
    }
  });
}

module.exports = { openBrowser: openBrowser };
