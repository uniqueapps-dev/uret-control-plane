# URET Control Plane

Tooling for URET, a phone-first control plane for AI-assisted work.

| Part | Path | Purpose |
|---|---|---|
| Notion setup script | `create-uret-databases.js` | One-off setup/repair of the five URET Notion databases. Frozen; not used by the bot. |
| URET Control Bot (Phase 1) | `bot/` | Telegram bot skeleton, run from Termux with long polling. |

## URET Control Bot MVP v0.1 — Phase 1

Phase 1 is a small, deterministic Telegram bot skeleton. It **does not read or
write any URET records** and has no connection to any other system.

### Commands

| Command | What it does |
|---|---|
| `/start` | Introduction and the list of commands |
| `/help` | The list of commands |
| `/cancel` | Clears the current in-memory interaction. Nothing is created or changed. |
| `/health` | Local checks only: configuration present, log and runtime folders writable, session store and command handlers available |

Any other message gets a pointer to `/help`.

### Who can use it

Only one Telegram account: the one whose **numeric user ID** matches
`TELEGRAM_ALLOWED_USER_ID`, and only in a **private chat** with the bot.
Usernames and display names are never used. Messages from anyone else, or from
groups, are silently ignored.

### Requirements

- Node.js 18 or newer (Termux: `pkg install nodejs git`)
- No npm packages are needed to run the bot.
- A Telegram bot token from @BotFather, created for this bot only.
- Your own numeric Telegram user ID (a number, not your `@username`).

### Setup on Termux

```sh
git clone https://github.com/uniqueapps-dev/uret-control-plane.git
cd uret-control-plane
git checkout feature/uret-control-bot-mvp-v0.1
cp .env.example .env
chmod 600 .env
nano .env        # fill in both values; never commit or share this file
```

`.env` is ignored by Git. Only `.env.example`, which has no values, is committed.

### Run

Load `.env` into the shell and start the bot (works on any Node 18+):

```sh
set -a; . ./.env; set +a
npm run start:bot
```

On Node 20.6 or newer you can instead run `node --env-file=.env bot/index.js`.

Stop it with **Ctrl+C**. The bot stops polling and exits without writing anything.

If either variable is missing or malformed, the bot exits and names the
variable and its status (`missing` or `malformed`), never the value.

### Behaviour worth knowing

- **Restart:** messages sent while the bot was stopped are discarded, not run.
  All in-memory state is lost on restart; nothing is restored or written.
- **Logs:** one JSON line per event in `logs/bot.log` (also printed to the
  terminal). Only these fields are recorded: timestamp, event, command,
  result, error class, duration, and whether the sender was authorized.
  Message text, user IDs, URLs and tokens are never logged.
- **`/health`** confirms only that the bot process is running and polling. It is
  not watched by any external supervisor; if Termux kills the process, nothing
  restarts it.
- `logs/`, `runtime/` and `state/` are local and ignored by Git.

### Tests

```sh
npm test
```

Tests use a fake Telegram API and randomly generated fake tokens. They make no
network calls and write only to temporary folders.
