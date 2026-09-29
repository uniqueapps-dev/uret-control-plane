# URET Control Plane

Tooling for URET, a phone-first control plane for AI-assisted work.

| Part | Path | Purpose |
|---|---|---|
| Notion setup script | `create-uret-databases.js` | One-off setup/repair of the five URET Notion databases. Frozen; not used by the bot. |
| URET Control Bot | `bot/` | Telegram bot run from Termux with long polling. With Notion configured it reads URET records and **creates** new Opportunities, Specs and Work Packages through guided questions. It never changes or deletes existing records. |

## URET Control Bot MVP v0.1

A small, deterministic Telegram bot. When Notion is configured it can read the
URET records under URET Root and **create** new Opportunities, Specs and Work
Packages through guided questions. It **never changes or deletes existing
records**: its only write is Notion's "create page". Without Notion it runs
exactly as in Phase 1.

### Commands

| Command | What it does |
|---|---|
| `/start` | Introduction and the list of commands |
| `/help` | The list of commands |
| `/cancel` | Ends the current guided session. Nothing is created. |
| `/status` | Opportunity counts by status, read from Notion |
| `/show <URET-ID>` | One Opportunity, Spec or Work Package by its URET ID |
| `/health` | Local checks plus read-only Notion checks |
| `/new_opportunity` | Create an Opportunity (7 guided questions) |
| `/new_spec <OPP-ID>` | Create a Spec for an Opportunity (6 guided questions) |
| `/new_work <SPEC-ID>` | Create a Work Package for a Spec (6 guided questions) |

`/start` and `/help` list these nine commands. `/start` also says:

```
It can create new Opportunities, Specs and Work Packages through guided questions.
It never changes or deletes existing URET records.
```

Any other message gets a pointer to `/help`, unless a guided session is open
(then it is taken as the answer to the current question).

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

**`/show <URET-ID>`** accepts `OPP-…`, `SPEC-…` and `WP-…` IDs:

```
/show OPP-002
/show SPEC-001
/show WP-001
```

- IDs are normalised: `opp-1`, `OPP-1`, `opp-001` and `OPP-001` all mean
  `OPP-001` (the same for `SPEC` and `WP`). Anything else (`OPP-0`, `EVD-1`,
  extra words) gets
  `Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001` and
  nothing is read.
- `/show` alone gets `Usage: /show <URET-ID>` /
  `Examples: /show OPP-001, /show SPEC-001, /show WP-001`.
- **Opportunity:** URET ID, Name, Status, Asset type, Project / Asset, Problem
  summary, Target users, Success metrics, Next action, Created, Last updated
  (UTC) and `Notion link:`.
- **Spec:**

  ```
  SPEC-001 — Bike Tracker Prototype

  Version: v0.1
  Opportunity: OPP-002
  Status: Draft
  Summary: …
  Scope in: …
  Scope out: …
  Constraints: …

  Notion link: https://www.notion.so/…
  ```

- **Work Package:**

  ```
  WP-001 — Harden Bike Tracker prototype

  Type: Hardening
  Worker: Claude Code
  Spec: SPEC-001
  Status: Draft
  Summary: …
  Instructions: …
  Outputs: …

  Notion link: https://www.notion.so/…
  ```

  A Spec's Opportunity and a Work Package's Spec are shown by URET ID. The bot
  finds them through the other side of the two-way relation (the Opportunity
  whose `Specs` include this Spec, the Spec whose `Work packages` include this
  Work Package), with one more read.
- `Notion link:` is the page URL Notion returns, or `unavailable`. Long text
  fields are cut to 300 characters with `…`; empty fields show `—`. A trashed
  record is marked `Archived/trashed record` on the first line.
- No match: `Not found: SPEC-001`. More than one match:
  `Notion: Data integrity problem` / `Duplicate URET ID: SPEC-001` (the bot
  never picks one).

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
Notion configuration the last three Notion lines are `NOT CHECKED`. `/health`
checks only the Opportunities source; it never writes.

When Notion cannot answer a read, replies are fixed and short:
`Notion: Unavailable`, `Notion: Access problem`, `Notion: Request problem`,
`Notion: Configuration or access problem`, `Notion: Schema problem` or
`Notion configuration: NOT OK`. Telegram never shows variable names, page or
data-source IDs, tokens or Notion error details.

### Creating records

All three creation commands work the same way:

- The bot asks one question at a time. Each reply answers the current
  question, and the next question is numbered (`3/7`, …).
- **Free-text answers** are required; send `-` to leave one empty. Each is at
  most 2,000 characters.
- **Titles** are a single line of at most 200 characters.
- **Choice questions** take the option's number or its exact name (any case).
- An invalid answer gets the reason and the same question again; nothing is
  written.
- **After the last answer** the bot, in order:
  1. checks the parent again (`/new_spec`, `/new_work`);
  2. reserves the next URET ID;
  3. checks the target database's schema;
  4. creates the record with its starting Status;
  5. replies with a confirmation.
- **One session at a time.** Starting another gets
  `You already have an active session. Finish it or use /cancel.` Other
  commands (`/help`, `/status`, `/show`, …) still work during a session.
- **`/cancel`** replies `Cancelled. No record created.`, or
  `No active session to cancel.` when there is none.
- **Sessions expire 30 minutes after they start**, whatever the activity. The
  next answer then gets, for example, `Session expired. Use /cancel to stop or /new_spec to restart.`
- Sessions are kept in memory only; a restart ends them. Answers are never
  logged.

**`/new_opportunity`**

```
/new_opportunity
New Opportunity: 7 questions. Send /cancel to stop.

1/7 Title? (max 200 characters)
```

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Asset type | `1` App/PWA, `2` Ebook, `3` Video series, `4` Landing page / site, `5` Template |
| 3 | Project / Asset | Free text or `-` |
| 4 | Problem summary | Free text or `-` |
| 5 | Target users | Free text or `-` |
| 6 | Success metrics | Free text or `-` |
| 7 | Next action | Free text or `-` |

Status is set to **Idea**. Confirmation:

```
Created OPP-002

Title: Bike maintenance tracker
Asset type: App/PWA
Project / Asset: Bike Tracker
Status: Idea
Next action: Create prototype brief

Stored in URET – Opportunities.
```

**`/new_spec <OPP-ID>`**

```
/new_spec OPP-002
New Spec for OPP-002: 6 questions. Send /cancel to stop.

1/6 Title? (max 200 characters)
```

**Parent check:** before any question, the Opportunity must exist exactly once
and not be in the trash. Otherwise no session starts and the bot replies:

- `Opportunity OPP-002 not found.`
- `Data integrity problem: multiple records found for OPP-002.`
- `Opportunity OPP-002 is in the trash.`

`/new_spec` with no ID replies `Usage: /new_spec <OPP-ID>`; a non-OPP ID gets
`Invalid Opportunity ID. Example: /new_spec OPP-001`. The Opportunity is checked
again after the last answer.

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Version | Required, one line, max 50 characters (for example `v0.1`) |
| 3 | Summary | Free text or `-` |
| 4 | Scope in | Free text or `-` |
| 5 | Scope out | Free text or `-` |
| 6 | Constraints | Free text or `-` |

Status is set to **Draft** and the Spec is linked to the Opportunity.
Confirmation:

```
Created SPEC-001

Title: Bike Tracker Prototype
Version: v0.1
Opportunity: OPP-002
Status: Draft

Stored in URET – Specs.
```

**`/new_work <SPEC-ID>`**

```
/new_work SPEC-001
New Work Package for SPEC-001: 6 questions. Send /cancel to stop.

1/6 Title? (max 200 characters)
```

**Parent check:** the same as for `/new_spec`, for the Spec: `Spec SPEC-001 not
found.`, `Data integrity problem: multiple records found for SPEC-001.` or
`Spec SPEC-001 is in the trash.`, and no session starts. With no ID, or a
non-SPEC ID, the bot replies with usage or
`Invalid Spec ID. Example: /new_work SPEC-001`.

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Type | `1` Prototype, `2` Feature, `3` Bug fix, `4` Research, `5` Hardening |
| 3 | Worker | `1` Claude Code, `2` Manual (Emmanuel) |
| 4 | Summary | Free text or `-` |
| 5 | Instructions | Free text or `-` |
| 6 | Outputs | Free text or `-` |

For Worker, `Emmanuel` (any case) is accepted and stored as **Manual**. Status
is set to **Draft** and the Work Package is linked to the Spec. Confirmation:

```
Created WP-001

Title: Harden Bike Tracker prototype
Type: Hardening
Worker: Claude Code
Spec: SPEC-001
Status: Draft

Stored in URET – Work Packages.
```

**If creation fails**, the session has already ended, so the command must be
started again. The reply is one of:

| Reply | Meaning |
|---|---|
| `Notion write failed. Please try again.` | Notion refused the record. |
| `Notion is unavailable. Please try again later.` | Notion timed out, was busy or rate-limited, or could not be reached. Nothing was created. |
| `Notion access problem. Check configuration.` | The token or its access is wrong, or a database could not be found under URET Root. |
| `Notion schema problem. Cannot create record.` | A property is missing or has the wrong type, or a chosen option (for example an Asset type or Status "Draft") does not exist in Notion. The bot never adds options. |
| `ID allocation failed. Please try again.` | The counter file is locked, unreadable or could not be saved, or more than 25 IDs in a row already exist in Notion (see [URET IDs](#uret-ids)). Nothing was created. |
| `Notion did not confirm the write. Check Notion for OPP-005 before trying again.` | The create was sent, but the answer was lost (timeout, network or server error). The record may exist. Check Notion before creating it again. |

### URET IDs

New IDs come from `uret-id-counters.json`, which holds the last number used
per prefix (for example `"OPP": 1` means OPP-001 is taken and OPP-002 is next).
For each new record the bot:

1. takes the lock `uret-id-counters.json.lock`, the same lock the setup script
   uses, so the two never allocate at the same time;
2. checks each candidate ID in Notion and skips any that already exist
   (including trashed or duplicated ones), at most 25 in a row;
3. saves the new number (written to a temporary file, flushed, then renamed
   over the original) and releases the lock.

A reserved number is never given back, even if creating the record then fails,
so **gaps are normal** (for example OPP-004 missing between OPP-003 and
OPP-005). Duplicates are prevented by the Notion check, even if the counter
file is reset, for example by `git checkout`.

`uret-id-counters.json` is tracked by Git, so after creating records
`git status` shows it as changed. That is expected. Before `git pull` or
`git checkout`, commit it or keep a copy. If it is overwritten anyway, the
Notion check still prevents duplicate IDs.

If the bot is killed while it holds the lock, `uret-id-counters.json.lock` is
left behind and every creation replies `ID allocation failed. Please try
again.` Delete that file, **only when neither the bot nor the setup script is
running**.

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
  integration token with **Read content** and **Insert content**, and the URET
  Root page ID.

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
| `NOTION_TOKEN` | `/status`, `/show`, the creation commands, Notion lines of `/health` |
| `URET_ROOT_PAGE_ID` | Same as above (32 hex characters, with or without dashes) |

**Notion is optional.** If both Notion variables are empty, the bot starts
normally, `/start`, `/help`, `/cancel` and `/health` work, and `/status`,
`/show`, `/new_opportunity`, `/new_spec` and `/new_work` reply
`Notion configuration: NOT OK`. If only one is set, or either is malformed,
the bot still starts and the terminal (never Telegram) names the variable and
whether it is `missing` or `malformed`, never its value.

**Install the Notion library.** This is required whenever Notion is
configured:

```sh
npm ci
```

This installs exactly `@notionhq/client` 5.26.0 from `package-lock.json`. No
other package is used.

### Notion integration

Use a **separate** Notion integration for the bot, for example
**URET Control Bot**:

1. Create an internal integration in Notion's integration settings.
2. Under its capabilities, allow **Read content** and **Insert content**.
   **Insert content** is required to create records. Leave **Update content**
   off: the bot never needs it.
3. Connect it only to the **URET Root** page (the databases under it inherit
   access). Do not connect it anywhere else.
4. Put its token in `NOTION_TOKEN` in `.env`.

If the bot was set up with a read-only integration in Phase 2A, turn on
**Insert content** for it (or create a new integration) before using the
creation commands. Without it, creation replies
`Notion access problem. Check configuration.`

> **To confirm in the first live test:** a new Spec or Work Package is linked
> to its parent through a two-way relation, so Notion also fills in the
> parent's reverse property (`Specs` or `Work packages`). Whether Notion
> requires **Update content** for that has not been tested against the live
> workspace. If creating a Spec fails with an access problem while
> `/new_opportunity` works, that is the likely cause.

Independently of the token's permissions, the bot code is limited to:

- **Reads:** only `bot/notion.js` reads, with four operations: list the root
  page's child blocks, retrieve a database, retrieve a data source, and query a
  data source.
- **Writes:** only `bot/notionWrite.js` writes. It calls only
  `dataSources.retrieve`, to check the schema, and `pages.create`, which
  appears exactly once in the code. It builds every property itself and fixes
  the starting Status.
- **Never:** no page update, delete, move or append, no search, and no generic
  request. Static tests (`test/static.test.js`) fail the build if any
  appears, or if another file loads the Notion library. The adapter tests run
  against fake Notion clients that throw on anything else.
- **Requests:** Notion requests use API version 2025-09-03, a 10-second timeout
  and **no retries**. The Notion library's own console logging is switched off,
  and Notion errors are reduced to fixed labels before they reach logs or
  replies.

### How the bot finds the URET databases

On the first command that needs a database, the bot lists the direct children
of URET Root and requires **exactly one** database with the expected title
(`URET – Opportunities`, `URET – Specs`, `URET – Work Packages`,
`URET – Evidence` or `URET – Releases`; dash, spacing and case differences are
ignored). It then checks that:

- the database's parent is URET Root;
- it is not in the trash;
- it has exactly one data source;
- the data source has the required properties and types (for Opportunities,
  Status options Idea, Active, Parked and Done).

Each data source is remembered in memory only, until the bot restarts. If
Notion later reports one missing, the bot forgets it and looks again on the
next command. Before every create, the target data source's schema is read
again.

### Run

Load `.env` into the shell and start the bot (works on any Node 18+):

```sh
set -a; . ./.env; set +a
npm run start:bot
```

On Node 20.6 or newer you can instead run `node --env-file=.env bot/index.js`.

Stop it with **Ctrl+C**. The bot stops polling and abandons any pending Notion
request without replying. If that was a create, it may still have reached
Notion: check with `/show` after restarting.

If a Telegram variable is missing or malformed, the bot exits and names the
variable and its status (`missing` or `malformed`), never the value.

### Limitations

- **Create only:** the bot creates Opportunities, Specs and Work Packages. It
  cannot update, delete, move or re-link records; do that in Notion.
- **No Evidence or Release creation yet.** The bot recognises those databases
  but has no command that creates or shows them.
- **ID gaps:** a reserved ID is never given back, so a failed or unconfirmed
  create leaves a gap in the numbering.
- **No retry of answers:** if creation fails, the answers are gone and the
  command must be started again.
- **Options must already exist:** the bot never adds select options to Notion.
  A missing option makes creation reply with the schema problem text.
- **Placement:** the databases must sit **directly** on URET Root, not inside a
  column, toggle or sub-page. Zero or several matching databases are reported
  as a configuration or access problem; the bot never guesses.
- **No workspace search:** the bot only looks under URET Root.
- **1,000-record cap:** `/status` reads at most 10 pages of 100 records. With
  more, it reports the counts as incomplete instead of partial numbers.
- **Timeout, no retry:** each Notion request times out after 10 seconds and is
  never retried. Send the command again later if you want to try again.
- **Trashed records:** trashed Opportunities are excluded from `/status`. If
  Notion's query does not return trashed pages, `/show` for a trashed record
  says `Not found` rather than `Archived/trashed record`. There is no fallback
  search.
- **Root page size:** if URET Root has more than 1,000 child blocks, discovery
  stops and reports the source as ambiguous.
- **One command at a time:** messages are handled in order, so a slow Notion
  request (up to 10 seconds each) delays the next message.
- **Notion links contain the page's ID**, as Notion's page URLs do. Data-source
  and root page IDs are never shown.

### Behaviour worth knowing

- **One copy only:** if another process is already receiving updates for the
  same bot token, Telegram reports a conflict and the bot stops with exit code 1
  instead of retrying. Stop the other copy, then start the bot again.
- **Restart:** messages sent while the bot was stopped are discarded, not run.
  All in-memory state, including open guided sessions, is lost on restart;
  nothing is restored.
- **Logs:** one JSON line per event in `logs/bot.log` (also printed to the
  terminal). Only these fields are recorded: timestamp, event, command,
  result, error class, duration, and whether the sender was authorized.
  Message text, answers, URET IDs of created records, user IDs, URLs, tokens
  and Notion IDs are never logged.
- **`/health`** confirms that your command reached the bot and reports what it
  could check at that moment. It does not mean anything is watching or
  restarting the bot. If Termux stops the process, nothing restarts it.
- **Files written:** `logs/` (local, ignored by Git) and
  `uret-id-counters.json`, with its short-lived lock and temporary files, when
  a record is created. Guided sessions are kept in memory only.

### Out of scope

The bot does not use AI or language models, Hermes, the GitHub API, cloud
hosting, web crawlers or webhooks. It does not update, delete or move records,
does not create Evidence or Releases, and does not use the setup script.

`create-uret-databases.js` and `package-lock.json` are left unchanged by the
bot work. `uret-id-counters.json` is changed only by ID allocation.

### Tests

```sh
npm ci      # once; the tests use the Notion library's error classes
npm test
```

Tests use a fake Telegram API, fake Notion clients and randomly generated fake
tokens and IDs. They make no network calls and write only to temporary folders.
They never read or write the real `uret-id-counters.json`: a guard makes any
such access fail the run, and checks afterwards that the file is unchanged.
