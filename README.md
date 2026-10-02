# URET Control Plane

Tooling for URET, a phone-first control plane for AI-assisted work.

| Part | Path | Purpose |
|---|---|---|
| Notion setup script | `create-uret-databases.js` | One-off setup/repair of the five URET Notion databases. Frozen; not used by the bot. |
| URET Control Bot | `bot/` | Telegram bot run from Termux with long polling. With Notion configured it reads URET records, **creates** Opportunities, Specs, Work Packages and Evidence through guided questions, and **changes the Status** of existing Opportunities, Specs and Work Packages. It never deletes records or changes any other field. |

## URET Control Bot MVP v0.1

## 1. Overview

A small, deterministic Telegram bot for working with the URET records in
Notion from a phone. It can:

- **create** Opportunities, Specs, Work Packages and Evidence, by asking one
  question at a time;
- **change the Status** of an Opportunity, Spec or Work Package, and nothing
  else;
- **show** any of those records, Opportunity counts, and the active work with
  its evidence.

It never deletes a record, never changes any field other than Status, and never
uses AI or language models. Without Notion configured it still answers
`/start`, `/help`, `/cancel` and `/health`.

**Architecture.** Telegram long polling (`bot/telegram.js`) → authorization
(`bot/auth.js`: one numeric user ID, private chats only) → command router
(`bot/commands.js`). Notion is reached only through two adapters:

| Adapter | Calls | Used for |
|---|---|---|
| `bot/notion.js` (read) | `blocks.children.list`, `databases.retrieve`, `dataSources.retrieve`, `dataSources.query` | finding the databases, checking schemas, lookups, counts |
| `bot/notionWrite.js` (write) | `dataSources.retrieve`, `pages.create`, `pages.update` (Status only) | creating records, changing Status |

Guided sessions live in memory (`bot/captureSession.js`); new URET IDs come
from `uret-id-counters.json` with a Notion check (`bot/idCounter.js`). Logs
record only the command name, the result and fixed labels.

## 2. Commands

| Command | What it does |
|---|---|
| `/start` | Introduction and the list of commands |
| `/help` | The list of commands |
| `/cancel` | Ends the current guided session. Nothing is created. |
| `/status` | Opportunity counts by status, then the active work with its evidence |
| `/show <URET-ID>` | One Opportunity, Spec, Work Package or Evidence record |
| `/health` | Local checks plus read-only Notion checks |
| `/new_opportunity` | Create an Opportunity (7 guided questions) |
| `/new_spec <OPP-ID>` | Create a Spec for an Opportunity (6 guided questions) |
| `/new_work <SPEC-ID>` | Create a Work Package for a Spec (6 guided questions) |
| `/new_evidence <WP-ID>` | Record Evidence for a Work Package (5 guided questions) |
| `/update_status <URET-ID> <status>` | Change the Status of an Opportunity, Spec or Work Package |

`/start` ends with:

```
It can create new Opportunities, Specs, Work Packages and Evidence through guided questions.
It can change the Status of existing Opportunities, Specs and Work Packages.
It never deletes records or changes any other field.
```

Any other message gets `Unknown command. Use /help to see the available
commands.`, unless a guided session is open: then it is the answer to the
current question.

**IDs** are normalised everywhere: `opp-1`, `OPP-1`, `opp-001` and `OPP-001` all
mean `OPP-001`, and the same goes for `SPEC`, `WP` and `EVD`.

### `/status`

```
Notion: Connected
Total: 12
Idea: 4
Active: 3
Parked: 2
Done: 3

Active work:
• WP-002 — Harden Bike Tracker prototype
  Spec: SPEC-002
  Evidence: 1
• WP-003 — PBSRx offline mode
  Spec: SPEC-003
  Evidence: 0
```

- **Counts.** Instead of the counts, the first part can be
  `Notion: Data integrity problem` / `Unexpected Opportunity status values found.`
  (a non-trashed Opportunity has no status, or one other than Idea, Active,
  Parked or Done; nothing is repaired), or `Notion: Connected` /
  `Counts: Incomplete` / `At least 1,000 records were scanned.` /
  `Use Notion directly for the full dataset.` (more than 1,000 records).
- **Active work** follows in every case: the Work Packages whose Status is
  "In progress" or "Draft", most recently edited first, at most 5. Each shows
  its Spec (by URET ID) and its evidence count; a count cut short shows `+`
  (for example `Evidence: 1000+`). With none: `Active work: None`. With more
  than 5: a last line `More active work in Notion.`
- **Failures.** If the counts cannot be read, the reply is only the Notion text
  (see [Error messages](#4-error-messages)). If only the active work cannot be
  read, the counts stand and the section is `Active work: unavailable`.

### `/show <URET-ID>`

Accepts `OPP-…`, `SPEC-…`, `WP-…` and `EVD-…`. `/show` alone replies
`Usage: /show <URET-ID>` / `Examples: /show OPP-001, /show SPEC-001, /show WP-001, /show EVD-001`;
anything else gets
`Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001, /show EVD-001`
and nothing is read.

- **Opportunity:** URET ID, Name, Status, Asset type, Project / Asset, Problem
  summary, Target users, Success metrics, Next action, Created, Last updated
  (UTC) and `Notion link:`.
- **Spec:**

  ```
  SPEC-002 — Bike Tracker Prototype

  Version: v0.1
  Opportunity: OPP-002
  Status: Draft
  Evidence: 3
  Summary: …
  Scope in: …
  Scope out: …
  Constraints: …

  Notion link: https://www.notion.so/…
  ```

  `Evidence` is the total over the Spec's Work Packages.
- **Work Package:**

  ```
  WP-002 — Harden Bike Tracker prototype

  Type: Hardening
  Worker: Manual
  Spec: SPEC-002
  Status: In progress
  Evidence: 2
  Summary: …
  Instructions: …
  Outputs: …

  Notion link: https://www.notion.so/…
  ```
- **Evidence:**

  ```
  EVD-002 — Prototype works on LG G8X. Expense logging is clear.

  Type: Test results
  Verdict: Pass
  Work package: WP-002
  Summary: Prototype works on LG G8X. Expense logging is clear.
  Details: Next oil-change date needs to be more visible on home screen.
  Next action: Add service card to dashboard.

  Notion link: https://www.notion.so/…
  ```

  Details and Next action are read from the labelled sections of the Summary
  (see [Evidence](#evidence)). A Summary without those labels (written by hand,
  or the setup script's EVD-001) shows in full as Summary, with `—` for
  Details and Next action.

A Spec's Opportunity, a Work Package's Spec and an Evidence record's Work
package are found through the other side of their two-way relation, by URET
ID. `Notion link:` is the page URL Notion returns, or `unavailable`. Long text
fields are cut to 300 characters with `…`; empty fields show `—`; a trashed
record is marked `Archived/trashed record` on the first line. No match:
`Not found: EVD-002`. More than one match: `Notion: Data integrity problem` /
`Duplicate URET ID: EVD-002` (the bot never picks one). If a linked record or
an evidence count cannot be read, the reply is the Notion text, never a
made-up value.

### `/health`

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
`NOT OK` if it failed, and `NOT CHECKED` if an earlier step failed. `/health`
checks only the Opportunities database and never writes. It confirms that your
command reached the bot; it does not mean anything is watching or restarting
the bot.

### Guided creation: `/new_opportunity`, `/new_spec`, `/new_work`, `/new_evidence`

All four work the same way:

- The bot asks one question at a time, numbered (`3/7`, …); each reply answers
  the current question. Choice questions take the option's number or its exact
  name (any case). An invalid answer gets the reason and the same question
  again; nothing is written.
- **One session at a time.** Starting another gets
  `You already have an active session. Finish it or use /cancel.` Other
  commands (`/help`, `/status`, `/show`, `/update_status`, …) still work during
  a session.
- **`/cancel`** replies `Cancelled. No record created.`, or
  `No active session to cancel.` when there is none.
- **Sessions expire 30 minutes after they start**, whatever the activity. The
  next answer then gets, for example,
  `Session expired. Use /cancel to stop or /new_evidence to restart.`
- **Parent check** (`/new_spec`, `/new_work`, `/new_evidence`): before any
  question, the parent must exist exactly once and not be in the trash;
  otherwise no session starts.
- **After the last answer** the bot checks the parent again, reserves the next
  URET ID (see [URET IDs](#uret-ids)), re-reads the target database's schema,
  creates the record, and replies with a confirmation. If creation fails, the
  session has already ended and the command must be started again.
- Sessions are kept in memory only; a restart ends them. Answers are never
  logged.

**`/new_opportunity`** — Status is set to **Idea**.

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Asset type | `1` App/PWA, `2` Ebook, `3` Video series, `4` Landing page / site, `5` Template |
| 3–7 | Project / Asset, Problem summary, Target users, Success metrics, Next action | Free text (max 2,000) or `-` to leave empty |

```
Created OPP-002

Title: Bike maintenance tracker
Asset type: App/PWA
Project / Asset: Bike Tracker
Status: Idea
Next action: Create prototype brief

Stored in URET – Opportunities.
```

**`/new_spec <OPP-ID>`** — Status **Draft**, linked to the Opportunity. With no
ID: `Usage: /new_spec <OPP-ID>` / `Example: /new_spec OPP-001`; a non-OPP ID:
`Invalid Opportunity ID. Example: /new_spec OPP-001`.

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Version | Required, one line, max 50 characters (for example `v0.1`) |
| 3–6 | Summary, Scope in, Scope out, Constraints | Free text (max 2,000) or `-` to leave empty |

```
Created SPEC-001

Title: Bike Tracker Prototype
Version: v0.1
Opportunity: OPP-002
Status: Draft

Stored in URET – Specs.
```

**`/new_work <SPEC-ID>`** — Status **Draft**, linked to the Spec. With no ID:
`Usage: /new_work <SPEC-ID>` / `Example: /new_work SPEC-001`; a non-SPEC ID:
`Invalid Spec ID. Example: /new_work SPEC-001`.

| # | Question | Answer |
|---|---|---|
| 1 | Title | Required, one line, max 200 characters |
| 2 | Type | `1` Prototype, `2` Feature, `3` Bug fix, `4` Research, `5` Hardening |
| 3 | Worker | `1` Claude Code, `2` Manual (Emmanuel) — `Emmanuel` in any case is stored as **Manual** |
| 4–6 | Summary, Instructions, Outputs | Free text (max 2,000) or `-` to leave empty |

```
Created WP-001

Title: Harden Bike Tracker prototype
Type: Hardening
Worker: Claude Code
Spec: SPEC-001
Status: Draft

Stored in URET – Work Packages.
```

**`/new_evidence <WP-ID>`** — linked to the Work Package (Evidence has no
Status). With no ID: `Usage: /new_evidence <WP-ID>` /
`Example: /new_evidence WP-001`; a SPEC or other ID:
`Invalid Work package ID. Example: /new_evidence WP-001`.

| # | Question | Answer |
|---|---|---|
| 1 | Type | `1` Observation, `2` Test results, `3` Research, `4` User feedback, `5` Metrics |
| 2 | Summary | Required, max 500 characters |
| 3 | Verdict | `1` Pass, `2` Fail, `3` Mixed, `4` N/A |
| 4 | Details | Required, max 2,000 characters, may span lines |
| 5 | Next action | Required, max 500 characters |

All three text answers are required: an empty answer or a bare `-` gets
`Answer required. This field cannot be empty.` The record's Name is the
Summary answer on one line, cut to 200 characters.

```
Created EVD-002

Type: Test results
Verdict: Pass
Work package: WP-002
Summary: Prototype works on LG G8X. Expense logging is clear.

Stored in URET – Evidence.
```

### `/update_status <URET-ID> <status>`

Changes the **Status** field of one Opportunity, Spec or Work Package. No
guided session. The status may be several words and is matched in any case
(`/update_status wp-2 in progress` sets "In progress").

| Type | Allowed statuses |
|---|---|
| Opportunity (`OPP-…`) | Idea, Active, Parked, Done |
| Spec (`SPEC-…`) | Draft, Approved, Superseded |
| Work Package (`WP-…`) | Draft, In progress, Done, Blocked |

In order, with nothing written until the last step:

1. Missing arguments: `Usage: /update_status <URET-ID> <status>` /
   `Example: /update_status OPP-002 Active`. An EVD, REL or malformed ID:
   `Invalid URET ID. Example: /update_status OPP-002 Active`. A status not in
   the type's list: `Invalid status. Use one of: Idea, Active, Parked, Done.`
   (that type's list). No Notion call is made.
2. The record is looked up: `Opportunity OPP-999 not found.` (or Spec, Work
   package); `Data integrity problem: multiple records found for OPP-002.`;
   `Opportunity OPP-002 is in the trash.`
3. Already at that status: `OPP-002 is already Active.` — nothing is written.
4. Otherwise the Status, and only the Status, is changed:
   `Updated OPP-002 status to Active.`

## 3. Schemas

The bot expects the five databases as the setup script creates them, directly
under URET Root. It checks the properties it uses (name and type) when it first
finds each database, and again before every write; select values must already
exist as options, because the bot never adds options.

### Opportunities (`URET – Opportunities`)

| Property | Type | Notes |
|---|---|---|
| URET ID | rich_text | `OPP-001`, … |
| Name | title | |
| Status | select | **Idea**, **Active**, **Parked**, **Done** (all four required) |
| Asset type | multi_select | App/PWA, Ebook, Video series, Landing page / site, Template |
| Project / Asset, Problem summary, Target users, Success metrics, Next action | rich_text | |
| Created / Last updated | created_time / last_edited_time | |
| Specs | relation | reverse side of Specs → Opportunity |
| Releases | relation | |

### Specs (`URET – Specs`)

| Property | Type | Notes |
|---|---|---|
| URET ID | rich_text | `SPEC-001`, … |
| Name | title | |
| Opportunity | relation → Opportunities | two-way; reverse property `Specs` |
| Version, Summary, Scope in, Scope out, Constraints, Branch | rich_text | |
| Status | select | **Draft**, **Approved**, **Superseded** |
| Repo | url | |
| Work packages | relation | reverse side of Work Packages → Spec |
| Releases | relation | |

### Work Packages (`URET – Work Packages`)

| Property | Type | Notes |
|---|---|---|
| URET ID | rich_text | `WP-001`, … |
| Name | title | |
| Spec | relation → Specs | two-way; reverse property `Work packages` |
| Type | select | Prototype, Feature, Bug fix, Research, Hardening |
| Worker | select | must include Claude Code and Manual |
| Status | select | **Draft**, **In progress**, **Done**, **Blocked** |
| Summary, Instructions, Outputs | rich_text | |
| Commit / PR | url | |
| Start date, End date | date | |
| Evidence | relation | reverse side of Evidence → Work package |

### Evidence

`URET – Evidence`:

| Property | Type | Notes |
|---|---|---|
| URET ID | rich_text | `EVD-001`, … |
| Name | title | the Summary answer on one line, max 200 characters |
| Work package | relation → Work Packages | two-way; reverse property `Evidence` |
| Type | select | Observation, Test results, Research, User feedback, Metrics |
| Summary | rich_text | structured, see below |
| Verdict | select | Pass, Fail, Mixed, N/A |
| Evidence link, Date | url, date | in the setup script's schema; not used by the bot |

Evidence has no Status. Details and Next action have no properties of their
own; `/new_evidence` stores them in **Summary** as labelled sections:

```
<summary>

Details:
<details>

Next action:
<next action>
```

`/show EVD` splits the text at the first `Details:` and `Next action:` labels.

## 4. Error messages

### Input and session

| Reply | When |
|---|---|
| `Unknown command. Use /help to see the available commands.` | An unknown command, or text with no session open |
| `Notion configuration: NOT OK` | A Notion command without Notion configured |
| `The title cannot be empty.` / `The title must be a single line.` / `The title is too long (max 200 characters).` | Title answers |
| `The version cannot be empty.` / `The version must be a single line.` / `The version is too long (max 50 characters).` | Spec Version answers |
| `Invalid asset type. Reply with a number from 1 to 5.` (also `type`, `worker`, `verdict`, with their own ranges) | Choice answers |
| `Please answer, or send - to leave it empty.` | An empty free-text answer (Opportunity, Spec, Work Package flows) |
| `Answer required. This field cannot be empty.` | An empty or `-` Evidence text answer |
| `Too long (max 2000 characters).` (or `500` for Evidence Summary and Next action) | Over-long text answers |
| `Please answer with text.` | A photo, sticker or other non-text message during a session |
| `You already have an active session. Finish it or use /cancel.` | A second creation command during a session |
| `Session expired. Use /cancel to stop or /new_… to restart.` | The first message after a session expired |
| Usage and invalid-ID texts | See each command above |

### Data integrity

| Reply | When |
|---|---|
| `Notion: Data integrity problem` / `Unexpected Opportunity status values found.` | `/status`: an Opportunity has no status or an unknown one |
| `Notion: Data integrity problem` / `Duplicate URET ID: …` | `/show`: more than one record has the ID |
| `Data integrity problem: multiple records found for …` | A parent (`/new_spec`, `/new_work`, `/new_evidence`) or `/update_status` target has a duplicated ID |
| `… not found.` / `… is in the trash.` | The parent or the `/update_status` target does not exist, or is trashed |

### Notion, when reading

Used by `/status`, `/show`, the parent check before a session, and the
`/update_status` lookup.

| Reply | Cause |
|---|---|
| `Notion: Unavailable` | Timeout, rate limit, server error, conflict or network failure |
| `Notion: Access problem` | The token is wrong or lacks access |
| `Notion: Request problem` | Notion rejected the request |
| `Notion: Configuration or access problem` | A database is missing, duplicated or not directly under URET Root |
| `Notion: Schema problem` | A required property is missing or has the wrong type |

### Notion, when writing

Used after the last answer of a creation command, and by `/update_status`.

| Reply | Meaning |
|---|---|
| `Notion write failed. Please try again.` | Notion refused the write. Nothing was created or changed. |
| `Notion is unavailable. Please try again later.` | Notion timed out, was busy or rate-limited, or could not be reached. Nothing was created or changed. |
| `Notion access problem. Check configuration.` | The token or its capabilities are wrong, or a database could not be found under URET Root. |
| `Notion schema problem. Cannot create record.` | A property is missing or mistyped, or a chosen option does not exist. The bot never adds options. |
| `Notion schema problem. Cannot update record.` | The same, for `/update_status` (for example the Status option is missing). |
| `ID allocation failed. Please try again.` | The counter file is locked, unreadable or could not be saved, or more than 25 IDs in a row already exist. Nothing was created. |
| `Notion did not confirm the write. Check Notion for OPP-005 before trying again.` | A create was sent but the answer was lost. The record may exist. |
| `Notion did not confirm the update. Check with /show OPP-002.` | A Status change was sent but the answer was lost. Setting a status twice is harmless. |

Telegram never shows variable names, page or data-source IDs, tokens or Notion
error details; logs contain only fixed labels.

## 5. Integration setup

### Who can use it

Only one Telegram account: the one whose **numeric user ID** matches
`TELEGRAM_ALLOWED_USER_ID`, and only in a **private chat** with the bot.
Usernames and display names are never used. Messages from anyone else, or from
groups and channels, are silently ignored and never reach Notion.

### Requirements

- Node.js 18 or newer (Termux: `pkg install nodejs git`).
- A Telegram bot token from @BotFather, created for this bot only.
- Your own numeric Telegram user ID (a number, not your `@username`).
- For the Notion commands: `npm ci` once, a Notion integration token with
  **Read content**, **Insert content** and **Update content**, and the URET
  Root page ID.

### Notion integration

Use a **separate** Notion integration for the bot, for example
**URET Control Bot**:

1. Create an internal integration in Notion's integration settings.
2. Under its capabilities, allow **Read content**, **Insert content** and
   **Update content**:
   - **Insert content** is needed to create records;
   - **Update content** is needed by `/update_status`. The bot's code still
     changes only the Status property; this is enforced by static tests.
3. Connect it only to the **URET Root** page (the databases under it inherit
   access). Do not connect it anywhere else.
4. Put its token in `NOTION_TOKEN` in `.env`.

An integration set up for Phase 2A (read only) or Phase 3-5 (read and insert)
must be given the missing capabilities first. Without Insert content, creation
replies `Notion access problem. Check configuration.`; without Update content,
`/update_status` does.

Independently of the token's permissions, the bot code is limited to:

- **Reads:** only `bot/notion.js` reads, with its four read operations.
- **Writes:** only `bot/notionWrite.js` writes. It calls `pages.create`
  (written once in the code) and `pages.update` (written once, with a payload
  that contains only the Status property), each after re-reading the target
  database's schema. It builds every property itself.
- **Never:** no delete, move or append, no other page call, no search, and no
  generic request. Static tests (`test/static.test.js`) fail the build if any
  appears, if `pages.update` is given any other payload, or if another file
  loads the Notion library.
- **Requests:** Notion API version 2025-09-03, a 10-second timeout and **no
  retries**. The Notion library's own console logging is switched off.

### Database setup

The databases are created by the setup script, `create-uret-databases.js`,
which the bot never runs. On the first command that needs a database, the bot
lists the direct children of URET Root and requires **exactly one** database
with the expected title (`URET – Opportunities`, `URET – Specs`,
`URET – Work Packages`, `URET – Evidence` or `URET – Releases`; dash, spacing
and case differences are ignored). It then checks that:

- the database's parent is URET Root;
- it is not in the trash;
- it has exactly one data source;
- the data source has the properties of [section 3](#3-schemas).

Each data source is remembered in memory until the bot restarts. If Notion later
reports one missing, the bot forgets it and looks again on the next command.

### URET IDs

New IDs come from `uret-id-counters.json`, which holds the last number used
per prefix (for example `"OPP": 2` means OPP-002 is taken and OPP-003 is next).
For each new record the bot:

1. takes the lock `uret-id-counters.json.lock`, the same lock the setup script
   uses, so the two never allocate at the same time;
2. checks each candidate ID in Notion and skips any that already exist
   (including trashed or duplicated ones), at most 25 in a row;
3. saves the new number (written to a temporary file, flushed, then renamed
   over the original) and releases the lock.

A reserved number is never given back, so **gaps are normal**. Duplicates are
prevented by the Notion check, even if the counter file is reset, for example
by `git checkout`. The setup script's example records (OPP-001, SPEC-001,
WP-001, EVD-001, REL-001) are skipped this way.

`uret-id-counters.json` is tracked by Git, so after creating records
`git status` shows it as changed; commit it or keep a copy before `git pull` or
`git checkout`. If the bot is killed while it holds the lock,
`uret-id-counters.json.lock` is left behind and every creation replies
`ID allocation failed. Please try again.` Delete that file, **only when neither
the bot nor the setup script is running**.

## 6. Known limitations

- **KL-1: a creation outcome can be lost in transit (accepted MVP
  limitation).** A record can be created successfully in Notion while the
  Telegram confirmation message is lost, so the operator sees no reply.
  Retrying in that case creates a duplicate record with the next ID: ID
  reservation prevents ID collisions, not duplicate records. This was observed
  live once (WP-002, Phase 3-5) and accepted for the MVP; the bot does not
  detect or prevent it.

  **Operator procedure: verify the outcome before retrying.** If a creation
  command gets no Telegram reply:
  1. Do not retry.
  2. Run `/show <expected-ID>`. The expected ID is the number now in
     `uret-id-counters.json`, because the number is saved when it is reserved,
     before the record is created: for example `"WP": 2` means `/show WP-002`.
  3. If the record exists, creation succeeded; do nothing more.
  4. Retry only if `/show` confirms `Not found`.
- **Relation targets are not checked.** The schema check confirms that a
  property is a relation, not which database it points to (for example
  Evidence → `Work package`). If a relation were re-pointed by hand, writes
  would fail with `Notion write failed. Please try again.` and linked records
  would show as `—`.
- **Performance.** `/status` reads the counts (up to 10 queries), the active
  work list, and two more queries per active Work Package, one after another:
  a few seconds is normal. `/show SPEC` makes one query for the Spec's Work
  Packages and one per Work Package (up to 25). The first command after a
  start also has to find each database.
- **Changes are limited to Status.** The bot cannot change other fields,
  delete, move or re-link records; do that in Notion. Evidence and Releases
  have no status command, and Releases cannot be created.
- **No retry of answers:** if creation fails, the answers are gone and the
  command must be started again.
- **Options must already exist** in Notion; a missing option is a schema
  problem.
- **`/health` checks only Opportunities**, not the other databases.
- **Placement:** the databases must sit **directly** on URET Root, not inside a
  column, toggle or sub-page. Zero or several matching databases are a
  configuration or access problem; the bot never guesses or searches the
  workspace.
- **Caps:** `/status` counts at most 1,000 Opportunities; evidence counts read
  at most 1,000 records per Work Package and 25 Work Packages per Spec (shown
  with `+` beyond that); discovery stops if URET Root has more than 1,000 child
  blocks.
- **Timeout, no retry:** each Notion request times out after 10 seconds and is
  never retried.
- **Trashed records:** if Notion's query does not return trashed pages, `/show`
  for a trashed record says `Not found` rather than `Archived/trashed record`.
- **One message at a time:** messages are handled in order, so a slow command
  delays the next one.
- **Notion links contain the page's ID**, as Notion's page URLs do. Data-source
  and root page IDs are never shown.
- **Restart:** messages sent while the bot was stopped are discarded, not run.
  Open guided sessions are lost. If the bot is stopped (Ctrl+C) during a write,
  the write may still reach Notion: check with `/show` after restarting.
- **One copy only:** if another process is already receiving updates for the
  same bot token, Telegram reports a conflict and the bot stops with exit code
  1 instead of retrying.

## 7. Testing

```sh
npm ci      # once; the tests use the Notion library's error classes
npm test
```

398 tests in 20 files (`node --test`), with a fake Telegram API, fake Notion
clients and randomly generated fake tokens and IDs. They make no network calls
and write only to temporary folders. They never read or write the real
`uret-id-counters.json`: a guard makes any such access fail the run, and
checks afterwards that the file is unchanged.

| Area | Files |
|---|---|
| Notion adapters | `notion.test.js`, `notionWrite.test.js` |
| Creation flows | `newOpportunity.test.js`, `newSpec.test.js`, `newWork.test.js`, `evidence.test.js`, `chain.test.js` (back-to-back creates and read-back) |
| Status | `updateStatus.test.js`, `status.test.js` |
| Sessions and IDs | `captureSession.test.js`, `idCounter.test.js`, `counterGuard.test.js` |
| Router, formats, whole bot | `commands.test.js`, `opportunities.test.js`, `bot.test.js` (including log checks for every creation command and `/update_status`) |
| Phase 1 modules | `auth.test.js`, `config.test.js`, `logger.test.js`, `session.test.js` |
| Static rules | `static.test.js` |

**Coverage.** `node --test --experimental-test-coverage test/*.test.js` reports
100% line coverage for every Phase 4 module. The only uncovered block in `bot/`
is `main()` in `bot/index.js`, which needs a live configuration; its wiring is
checked by a static test.

**Mutation testing.** During development each step was checked by introducing
deliberate bugs into the new code, one at a time (for example a widened status
list, an extra property in the update payload, a skipped Notion check), and
confirming that the tests fail. These checks were run by hand and are not part
of `npm test`.

### Live validation (Phase 4)

**Result: PASS.** Run on Termux against the live Notion workspace, at commit
`d10d2ef`, with 398/398 automated tests passing on that checkout. Verified:

| Check | Result |
|---|---|
| `/status` shows the `Active work:` section | Pass |
| OPP-002 is Active | Pass |
| SPEC-002 is linked to OPP-002 | Pass |
| WP-002 is active and linked to SPEC-002 | Pass |
| `/new_evidence WP-002` created EVD-002 | Pass |
| EVD-002 Type is `Test results` | Pass |
| EVD-002 Verdict is `Pass` | Pass |
| EVD-002 is linked to WP-002 | Pass |
| `/show EVD-002` shows the Evidence record | Pass |
| WP-002 shows the Evidence relation | Pass |
| `/status` reports `Evidence: 1` for WP-002 | Pass |

An earlier live `/status` showed only the counts, which is the pre-Phase 4
output; the code at `d10d2ef` always adds the `Active work:` section after the
counts. The final run above showed the section as specified.

## 8. Development

### Project structure

| File | Role |
|---|---|
| `bot/index.js` | Entry point: configuration, polling loop, wiring of the adapters |
| `bot/telegram.js`, `bot/auth.js`, `bot/config.js`, `bot/logger.js`, `bot/session.js` | Phase 1: Telegram client, authorization, configuration, logs, session store |
| `bot/commands.js` | Command router; `/status`, `/show`, `/health`, `/cancel` |
| `bot/captureSession.js`, `bot/captureFlows.js` | Guided sessions and the four creation flows |
| `bot/statusUpdate.js` | `/update_status` |
| `bot/opportunities.js` | ID parsing and reply formats |
| `bot/health.js` | `/health` |
| `bot/idCounter.js` | URET ID reservation |
| `bot/notion.js`, `bot/notionWrite.js` | The read and write adapters |
| `test/` | Tests (`helpers.js` holds shared fakes and the counter-file guard) |

### Static rules

`test/static.test.js` enforces, on every run:

- only `bot/notion.js` and `bot/notionWrite.js` load `@notionhq/client`, and
  only `bot/index.js` loads those adapters and the ID counter;
- the read adapter calls exactly its four reads; the write adapter calls exactly
  `pages.create` (once), `pages.update` (once, Status-only payload) and
  `dataSources.retrieve`; no other file touches a Notion client;
- no page API, search, generic request, delete, move or append anywhere else;
- database titles appear only in the adapters and the four locked
  "Stored in URET – …" confirmation lines (Releases only in the read adapter);
- the counter file is named only in `bot/idCounter.js` and `test/helpers.js`;
- no AI provider, webhook, server, GitHub or crawler code (the Worker option
  "Claude Code" is the one allowed literal), only the Telegram host, no new
  dependencies, and no token- or ID-shaped text.

### Deployment (Termux)

```sh
git clone https://github.com/uniqueapps-dev/uret-control-plane.git
cd uret-control-plane
git checkout feature/uret-control-bot-mvp-v0.1
cp .env.example .env
chmod 600 .env
nano .env        # fill in the values; never commit or share this file
npm ci           # installs exactly @notionhq/client 5.26.0 from package-lock.json
```

`.env` holds four variables; only `.env.example`, which has no values, is
committed.

| Variable | Needed for |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Always |
| `TELEGRAM_ALLOWED_USER_ID` | Always |
| `NOTION_TOKEN` | Every Notion command and the Notion lines of `/health` |
| `URET_ROOT_PAGE_ID` | Same (32 hex characters, with or without dashes) |

Notion is optional: with both Notion variables empty, the bot starts and the
Notion commands reply `Notion configuration: NOT OK`. If only one is set, or
either is malformed, the terminal (never Telegram) names the variable and
whether it is `missing` or `malformed`, never its value. If a Telegram variable
is missing or malformed, the bot exits the same way.

Run (any Node 18+):

```sh
set -a; . ./.env; set +a
npm run start:bot
```

On Node 20.6 or newer you can instead run `node --env-file=.env bot/index.js`.
Stop with **Ctrl+C**. To update: stop the bot, keep or commit
`uret-id-counters.json`, then `git pull` and `npm ci`.

**Logs:** one JSON line per event in `logs/bot.log` (also printed to the
terminal), with only timestamp, event, command, result, error class, duration
and whether the sender was authorized. Message text, answers, URET IDs, user
IDs, URLs, tokens and Notion IDs are never logged. **Files written:** `logs/`
(ignored by Git) and `uret-id-counters.json` with its short-lived lock and
temporary files.

### Out of scope

The bot does not use AI or language models, Hermes, the GitHub API, cloud
hosting, web crawlers or webhooks. It does not delete or move records, change
any field but Status, create Releases, or run the setup script.
`create-uret-databases.js` and `package-lock.json` are left unchanged by the
bot work; `uret-id-counters.json` is changed only by ID allocation.
