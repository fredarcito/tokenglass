[Leer en español](README.es.md)

# Claude Code Token Dashboard

A small, open source tool that shows **where your Claude Code tokens go** and points out the habits that waste them: sessions that run too long, caches lost after a pause, huge tool results, an expensive model used for simple tasks, and subagent usage.

It reads the files Claude Code already keeps on your computer and serves a dashboard on your own machine. **Nothing leaves your computer.** There is no account, no upload and no telemetry.

## What it does

- Totals by token type (input, output, cache write, cache read), by model and by day.
- A ranking of your most expensive sessions, with a turn-by-turn chart of the context size and markers for pauses, `/clear`, `/compact` and sudden jumps.
- Active session time that excludes long pauses, each session's total span, and a baseline for the usual context of a new session.
- Diagnostics with an estimated impact in tokens and a concrete tip for each one, plus your 3 most frequent mistakes.
- A saved history, so statistics survive after Claude Code deletes old sessions.
- Light and dark mode, English and Spanish, works on phones and small windows.

## Requirements

- Node.js 18 or newer (check with `node -v`).
- Mac, Linux or Windows.
- Nothing else. There are no npm dependencies to install.

## Install

```
git clone <repo> && cd <folder> && npm start
```

That is all. Replace `<repo>` with the repository URL and `<folder>` with the folder name git created.

You can also run it without cloning:

```
npx github:<user>/<repo>
```

## First run

Use these three commands, in this order, the first time:

```
npm run example
npm run check
npm start
```

1. **`npm run example`** opens the dashboard with made-up data, so you can see what everything looks like before touching your own files.
2. **`npm run check`** reads your real Claude Code files and prints a report that tells you whether the tool understands them. Claude Code's file format is not officially documented and can change between versions, so this is worth doing once. The report contains only counts and field names, so you can paste it into an issue.
3. **`npm start`** opens the dashboard with your own data.

Everything the dashboard shows is read again each time you reload the page.

## Create a shortcut (alias)

Replace the path with the folder where you cloned the project.

**Mac and Linux** (add the line to `~/.zshrc` or `~/.bashrc`, then open a new terminal):

```
alias claude-tokens='npm --prefix "$HOME/claude-token-dashboard" start'
```

**Windows (PowerShell)**. Open your profile with `notepad $PROFILE` (if it does not exist, create it first with `New-Item -Path $PROFILE -Force`) and add:

```
function claude-tokens { npm --prefix "$HOME\claude-token-dashboard" start }
```

Open a new PowerShell window and type `claude-tokens`.

## Adjust the thresholds

The default thresholds live in `src/config.js`. You do not need to edit that file: create `config.json` in the tool's own folder and write only the values you want to change.

| System | Where to create `config.json` |
| --- | --- |
| Mac / Linux | `~/.claude-token-dashboard/config.json` |
| Windows | `%USERPROFILE%\.claude-token-dashboard\config.json` |

Example:

```json
{
  "lang": "es",
  "thresholds": {
    "longSession": { "contextTokens": 150000, "turns": 80 },
    "cacheMiss": { "gapSeconds": 300, "cacheWriteTokens": 30000 }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `lang` | `null` | Default dashboard language: `"es"` or `"en"`. |
| `thresholds.longSession.contextTokens` | 100000 | A stretch of work is "too long" above this context size... |
| `thresholds.longSession.turns` | 60 | ...or after this many turns without `/clear` or `/compact`. |
| `thresholds.cacheMiss.gapSeconds` | 300 | Pause that is long enough for the prompt cache to expire. |
| `thresholds.cacheMiss.cacheWriteTokens` | 20000 | Cache written after the pause that counts as a lost cache. |
| `thresholds.hugeToolResult.chars` | 20000 | A tool result longer than this many characters is "huge". |
| `thresholds.expensiveModel.modelPattern` | `"opus"` | Models whose name matches this text are treated as the expensive ones. |
| `thresholds.expensiveModel.shortOutputTokens` | 150 | A turn with less output than this counts as a simple task. |
| `thresholds.expensiveModel.minShortTurns` | 5 | Minimum number of simple turns to report. |
| `thresholds.expensiveModel.minShortShare` | 0.5 | Minimum share (0 to 1) of the expensive turns that must be simple. |
| `thresholds.subagents.minTokens` | 20000 | Subagent usage below this is not reported. |
| `thresholds.pause.gapSeconds` | 300 | Gaps longer than this are marked as pauses in the session chart. |
| `thresholds.spike.minIncreaseTokens` | 30000 | Context jumps larger than this are marked as spikes. |
| `weights` | 1 / 5 / 1.25 / 0.1 | Approximate published Anthropic input-price ratios for input / output / cache write / cache read. Check Anthropic's pricing page; this estimate is not model-specific. |

Invalid values are ignored (the default is used) and a warning is shown in the terminal and in the dashboard.

### How the diagnostics work

| Diagnostic | When it appears | Impact estimate |
| --- | --- | --- |
| Session too long | Context above the limit, or too many turns without `/clear` or `/compact`. | Tokens read from the moment the limit was crossed. |
| Cache lost after a pause | A gap over 5 minutes followed by a large cache write (not counted after `/clear` or `/compact`). | The cache tokens written again. |
| Session resumed after a pause | After a gap over 5 minutes, a non-initial turn writes at least 20,000 cache tokens and at least 80% of the previous turn's context, with no `/clear` or `/compact` between. | Cases and rewritten cache tokens are grouped per session. |
| Huge tool result | A `tool_result` over 20,000 characters. | Characters divided by 4. |
| Expensive model for simple tasks | Many Opus turns with very short output. | Tokens of those turns. |
| Subagent usage | Lines marked `isSidechain`, grouped by session. | Tokens used by subagents. |

The impact is a count of tokens, not money. Use it to compare problems of the same kind and to spot the biggest ones.

Active duration sums the intervals between unique user and assistant messages and excludes gaps longer than 30 minutes (`IDLE_THRESHOLD_MS` in `src/config.js`). The session table shows that active time and the full span separately. The overview baseline is the median first-turn context for the current filters; it includes the system prompt, tools, MCP servers and `CLAUDE.md` files, partly cache-written and partly cache-read, and is not context inherited from another session.

Assistant lines are normalized once: responses are deduplicated within their session by `message.id` (falling back to request ID / UUID), choosing the usage with the highest output count and the last line on ties. Synthetic responses, absent usage and all-zero usage are excluded from token totals. Malformed JSON lines are skipped and counted in the dashboard's data-quality notice.

Run `npm run verify -- --session <session-id> [--project <name>] [--data <path>] [--lang en|es]` to independently stream a raw transcript and compare its response counts, token totals, first-turn context, active time, total span and task title with the dashboard's normalized output.

## What it does and doesn't do with your data

Plain and simple:

- **It runs only on your computer.** The server listens on `127.0.0.1`, never on your network, and no data is sent anywhere.
- **It only reads Claude Code's folder.** It never modifies, moves or deletes your Claude Code files.
- **It writes in one place only:** `~/.claude-token-dashboard/` (history and your optional settings). Never inside the repository.
- **The saved history contains summaries and short task/project labels:** token counts per day and per session, diagnostics and the session task title. It contains no prompts, code or tool output.
- **Other websites cannot read your data.** The page address contains a random secret token created each time you start the tool, the server refuses requests for any other host name, and it sends no cross-site (CORS) permissions.
- **It runs no commands** except the one that opens your browser (`open`, `xdg-open` or `start`).
- **One thing is loaded from the internet:** the Chart.js chart library, from a CDN, with a pinned version and an integrity check. Your data is not part of that request. If you are offline the charts do not load, but tables and diagnostics still work.
- **The dashboard shows short previews** of huge tool results (the first lines), so you can recognize them. They are shown on your screen only. They are not saved in the history and are not included in exports.
- **Exports** (JSON or image) may include task and project labels, numbers and diagnostics, but never prompts, code or tool output.
- **Never commit real `.jsonl` files.** The `.gitignore` already blocks them outside `example/`.

## Advanced

You normally only need the three npm commands above. They call `bin/cli.js`, which accepts these arguments:

| Argument | What it does |
| --- | --- |
| `--example` | Use the made-up files in `example/`. No history is read or written. |
| `--check` | Print the parser report and exit. |
| `--data <path>` | Read `.jsonl` files from this folder (all sub-folders). |
| `--lang <es\|en>` | Language of the terminal output. |
| `--no-open` | Do not open the browser automatically. |
| `--help`, `--version` | Show help or the version. |

Pass arguments through npm after `--`, for example `npm run check -- --lang es`, or call the file directly: `node bin/cli.js --data ./my-copy`.

Environment variables:

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000). If it is busy, the next free port is used. |
| `CLAUDE_DATA_DIR` | Folder with Claude Code's data. `--data` takes priority over it. |
| `CLAUDE_TOKEN_DASHBOARD_HOME` | Use another folder instead of `~/.claude-token-dashboard` (useful for tests). |

Where the data is read from by default: `~/.claude/projects` on Mac and Linux, `%USERPROFILE%\.claude\projects` on Windows.

Terminal language: `--lang`, then `"lang"` in `config.json`, then your system language (`LC_ALL`, `LC_MESSAGES`, `LANG`, or the system locale). Dashboard language: your last choice (saved in the browser), then `"lang"` in `config.json`, then the browser language (Spanish if it starts with `es`, English otherwise).

If Claude Code's file format changes, `npm run check` tells you which function of `src/parser.js` to review.

### Project layout

```
bin/cli.js          entry point and argument reading
src/main.js         program flow
src/server.js       local HTTP server and security checks
src/parser.js       reads the .jsonl files (defensive)
src/diagnostics.js  detects the problems
src/history.js      saved history
src/data.js         builds the data the dashboard receives
src/config.js       default thresholds, paths and path guard
src/check.js        npm run check
src/i18n/           translations (en.json, es.json) and helper
public/index.html   the dashboard (CSS and JS inside)
example/            made-up .jsonl files
```

## Add a language

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json` (for example `fr.json`) and translate every value. Keep the keys and the `{placeholders}` exactly as they are.
2. Add a `"lang.<code>"` entry to **every** translation file (the text of the button, for example `"lang.fr": "FR"`).
3. Add the code to `SUPPORTED` in `src/i18n/index.js`.

The dashboard shows a button for each language and the terminal picks it up from your system language. Please keep code, commands, file names and comments in English.

## Contribute

Issues and pull requests are welcome.

- Run `npm run example` and `npm run check -- --data example` before you open a pull request.
- Keep the project free of npm dependencies.
- Every visible text must exist in both `src/i18n/en.json` and `src/i18n/es.json` with the same keys. Never write user-facing text directly in the code.
- Never add real transcripts to the repository. Extend the files in `example/` with made-up data instead.
- If Claude Code changes its file format, open an issue with the output of `npm run check` (it is safe to share).

## License

MIT. See [LICENSE](LICENSE).
