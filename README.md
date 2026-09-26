# URET Control Plane

Tooling for URET, a phone-first control plane for AI-assisted work.

| Part | Path | Purpose |
|---|---|---|
| Notion setup script | `create-uret-databases.js` | One-off setup/repair of the five URET Notion databases. Frozen; not used by the bot. |
| URET Control Bot | `bot/` | Telegram bot run from Termux with long polling. Optional **read-only** view of URET Opportunities in Notion. |

## URET Control Bot MVP v0.1

A small, deterministic Telegram bot. It **never creates or changes URET
records**. When Notion is configured it can *read* one Notion data source,
**URET – Opportunities**; without Notion it runs exactly as in Phase 1.

### Commands

| Command | What it does |
|---|---|
| `/start` | Introduction and the list of commands |
| `/help` | The list of commands |
| `/cancel` | Clears the current in-memory interaction. Nothing is created or changed. |
| `/status` | Opportunity counts by status, read from Notion |
| `/show <URET-ID>` | One Opportunity by its URET ID, read from Notion |
| `/health` | Local checks plus read-only Notion checks |

Any other message gets a pointer to `/help`.

**`/status`** replies with one of:

```
Notion: Connected
Total: 7
Idea: 3
Active: 2
Parked: 1
Done: 1
```

- `Notion: Data integrity problem` / `Unexpected Opportunity status values found.`
  when any non-trashed Opportunity has a status other than Idea, Active, Parked
  or Done, or no status. No counts are shown; nothing is repaired.
- `Notion: Connected` / `Counts: Incomplete` / `At least 1,000 records were scanned.` /
  `Use Notion directly for the full dataset.` when there are more than 1,000
  records. No partial counts are shown.

**`/show <URET-ID>`**

- IDs are normalised: `opp-1`, `OPP-1`, `opp-001` and `OPP-001` all mean `OPP-001`.
  Anything else (`OPP-0`, `SPEC-1`, extra words) gets
  `Invalid URET ID. Example: /show OPP-001` and nothing is read.
- `/show` alone gets `Usage: /show <URET-ID>` / `Example: /show OPP-001`.
- One match shows: URET ID, Name, Status, Asset type, Project / Asset, Problem
  summary, Target users, Success metrics, Next action, Created, Last updated
  (UTC) and `Notion link:` (the page URL Notion returns, or `unavailable`).
  Long text fields are cut to 300 characters with `…`; empty fields show `—`.
  A trashed record is marked `Archived/trashed record` on the first line.
- No match: `Not found: OPP-001`. More than one match:
  `Notion: Data integrity problem` / `Duplicate URET ID: OPP-001` (the bot never
  picks one).

**`/health`**

```
URET CONTROL BOT HEALTH

Command handler: OK
Configuration: OK
Session store: OK
Logs: OK
Notion configuration: OK
Notion reachable: OK
Opportunities source: OK
Opportunities schema: OK
Hermes: Not used / isolated legacy system
```

Each Notion line says `OK` only if that read succeeded during this `/health`,
`NOT OK` if it failed, and `NOT CHECKED` if an earlier step failed. Without
Notion configuration the last three Notion lines are `NOT CHECKED`.

When Notion cannot answer, replies are fixed and short: `Notion: Unavailable`,
`Notion: Access problem`, `Notion: Request problem`,
`Notion: Configuration or access problem`, `Notion: Schema problem` or
`Notion configuration: NOT OK`. Telegram never shows variable names, page or
data-source IDs, tokens or Notion error details.

### Who can use it

Only one Telegram account: the one whose **numeric user ID** matches
`TELEGRAM_ALLOWED_USER_ID`, and only in a **private chat** with the bot.
Usernames and display names are never used. Messages from anyone else, or from
groups and channels, are silently ignored and never reach Notion.

### Requirements

- Node.js 18 or newer (Termux: `pkg install nodejs git`)
- A Telegram bot token from @BotFather, created for this bot only.
- Your own numeric Telegram user ID (a number, not your `@username`).
- Only for the Notion commands: `npm ci` once (see below), a Notion
  integration token and the URET Root page ID.

### Setup on Termux

```sh
git clone https://github.com/uniqueapps-dev/uret-control-plane.git
cd uret-control-plane
git checkout feature/uret-control-bot-mvp-v0.1
cp .env.example .env
chmod 600 .env
nano .env        # fill in the values; never commit or share this file
```

`.env` holds four variables. Only `.env.example`, which has no values, is
committed; `.env` is ignored by Git.

| Variable | Needed for |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Always |
| `TELEGRAM_ALLOWED_USER_ID` | Always |
| `NOTION_TOKEN` | `/status`, `/show`, Notion lines of `/health` |
| `URET_ROOT_PAGE_ID` | Same as above (32 hex characters, with or without dashes) |

**Notion is optional.** If both Notion variables are empty, the bot starts
normally, `/start`, `/help`, `/cancel` and `/health` work, and `/status` /
`/show` reply `Notion configuration: NOT OK`. If only one is set, or either is
malformed, the bot still starts and the terminal (never Telegram) names the
variable and whether it is `missing` or `malformed`, never its value.

**Install the Notion library** (only needed when Notion is configured):

```sh
npm ci
```

This installs exactly `@notionhq/client` 5.26.0 from `package-lock.json`. No
other package is used.

### Read-only Notion integration

Use a **separate** Notion integration for the bot, for example
**URET Control Bot Read Only**:

1. Create an internal integration in Notion's integration settings.
2. If Notion lets you choose its capabilities, allow **Read content** only.
3. Connect it only to the **URET Root** page (the databases under it inherit
   access). Do not connect it anywhere else.
4. Put its token in `NOTION_TOKEN` in `.env`.

Do not reuse the existing setup integration's token for the bot unless a
read-only integration is not possible and that decision has been made
explicitly, with the remaining write-permission risk documented.

Independently of the token's permissions, the bot code cannot write:

- Only `bot/notion.js` loads the Notion library, and it calls only four read
  operations: list the root page's child blocks, retrieve a database, retrieve a
  data source, and query a data source.
- There is no page API, search, generic request, or any create, update, delete,
  append or move call. Static tests (`test/static.test.js`) fail the build if
  one appears, and the adapter tests run against a fake Notion client that
  throws on anything outside those four reads.
- Notion requests use API version 2025-09-03, a 10-second timeout and **no
  retries**. The Notion library's own console logging is switched off, and
  Notion errors are reduced to fixed labels before they reach logs or replies.

### How the bot finds URET – Opportunities

On the first command that needs Notion, the bot lists the direct children of
URET Root and requires **exactly one** database titled `URET – Opportunities`
(dash, spacing and case differences are ignored). It then checks that the
database's parent is URET Root, that it is not in the trash, and that it has
exactly one data source, and that the data source has the required properties
and types, with Status options including Idea, Active, Parked and Done. The
data source is remembered in memory only, until the bot restarts. If Notion
later reports it missing, the bot forgets it and looks again on the next
command.

### Run

Load `.env` into the shell and start the bot (works on any Node 18+):

```sh
set -a; . ./.env; set +a
npm run start:bot
```

On Node 20.6 or newer you can instead run `node --env-file=.env bot/index.js`.

Stop it with **Ctrl+C**. The bot stops polling, abandons any pending Notion
read, and exits without writing anything.

If a Telegram variable is missing or malformed, the bot exits and names the
variable and its status (`missing` or `malformed`), never the value.

### Limitations

- **Placement:** the Opportunities database must sit **directly** on URET Root,
  not inside a column, toggle or sub-page. Zero or several matching databases
  are reported as a configuration or access problem; the bot never guesses.
- **No workspace search:** the bot only looks under URET Root.
- **1,000-record cap:** `/status` reads at most 10 pages of 100 records. With
  more, it reports the counts as incomplete instead of partial numbers.
- **Timeout, no retry:** each Notion request times out after 10 seconds and is
  never retried; the reply is `Notion: Unavailable`. Send the command again
  later if you want to try again.
- **Trashed records:** trashed Opportunities are excluded from `/status`. If
  Notion's query does not return trashed pages, `/show` for a trashed record
  says `Not found` rather than `Archived/trashed record`. There is no fallback
  search.
- **Root page size:** if URET Root has more than 1,000 child blocks, discovery
  stops and reports the source as ambiguous.
- **One command at a time:** commands are handled in order, so a slow Notion
  read (up to 10 seconds) delays the next command.
- **Notion links contain the page's ID**, as Notion's page URLs do. Data-source
  and root page IDs are never shown.

### Behaviour worth knowing

- **One copy only:** if another process is already receiving updates for the
  same bot token, Telegram reports a conflict and the bot stops with exit code 1
  instead of retrying. Stop the other copy, then start the bot again.
- **Restart:** messages sent while the bot was stopped are discarded, not run.
  All in-memory state is lost on restart; nothing is restored or written.
- **Logs:** one JSON line per event in `logs/bot.log` (also printed to the
  terminal). Only these fields are recorded: timestamp, event, command,
  result, error class, duration, and whether the sender was authorized.
  Message text, user IDs, URLs, tokens and Notion IDs are never logged.
- **`/health`** confirms that your command reached the bot and reports what it
  could check at that moment. It does not mean anything is watching or
  restarting the bot. If Termux stops the process, nothing restarts it.
- **No saved state:** conversation state is kept in memory only. The only thing
  written to disk is `logs/`, which is local and ignored by Git.

### Out of scope

The bot does not use AI or language models, Hermes, the GitHub API, cloud
hosting, web crawlers or webhooks. It does not create Opportunities, allocate
URET IDs, or touch URET – Specs, Work Packages, Evidence or Releases.

These files are left unchanged by the bot work: `create-uret-databases.js`,
`uret-id-counters.json` and `package-lock.json`.

### Tests

```sh
npm ci      # once; the tests use the Notion library's error classes
npm test
```

Tests use a fake Telegram API, a fake Notion client and randomly generated fake
tokens and IDs. They make no network calls and write only to temporary folders.
