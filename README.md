# Familiar

> A local-first companion creature that lives beside your coding tools, evolves based on your **real dev outcomes**, and reacts in a tone you choose.

A witch's *familiar* for your git + AI-coding life. It watches your commits, your green tests, and your merged PRs — and grows.

```
🦉 Lv.7 ▓▓▓▓░ · "another 2am commit, respect"
```

## The one rule

**XP comes from outcomes, never from activity.** Burning tokens is worth exactly zero. So is running a test suite that was already green — nothing changed, so nothing happened.

What counts is a **change of state**: a commit, a merged PR, and above all a check that *stopped being broken*. Run your tests twenty times while debugging and you earn nothing for nineteen of them; the twentieth, the one that goes from red to green, is the whole point.

Git can never see that. Git only records the finished result — you never commit the broken state. Watching the transition is what the shell integration is for.

## Install

```bash
npm install
npm run build
node dist/cli.js init
```

`init` scans ~60 days of your local git history to pick which of three species you get, then wires hooks and a statusline into `~/.claude/settings.json` (backing it up first, and merging rather than overwriting).

## Commands

| Command | What it does |
|---------|--------------|
| `familiar init` | Pick your species, wire up Claude Code |
| `familiar status` | Text card: form, level, XP, habits, checks |
| `familiar look` | Draw the sprite in your terminal (`--animate` to blink) |
| `familiar show` | Open the pixel-art widget in your browser |
| `familiar tone <name>` | `hype` · `deadpan` · `zen` · `gremlin` |
| `familiar voice on` | Speak the big moments out loud |
| `familiar shell install` | Count checks from your own terminal |
| `familiar uninstall` | Cleanly remove hooks + statusline |

## Seeing it

`familiar look` draws the same 16×16 sprite the widget uses, as half-block characters —
16 columns by 8 rows, which comes out square because a terminal cell is about twice as
tall as it is wide.

It adapts down rather than refusing: 24-bit colour where the terminal has it, the xterm-256
palette where it doesn't, and a plain `█ ▀ ▄` silhouette with no escape codes at all when
you set `NO_COLOR` or pipe it somewhere. You always get the creature; you don't always get
the colour.

## Hearing it

`familiar voice on` speaks four moments out loud: a level up, an evolution, a fix that took
several attempts, and a fix you made alongside an agent. Nothing else — a footer line you
can ignore is not the same kind of interruption as a voice in the room.

It uses whatever your OS already has (SAPI on Windows, `say` on macOS, `spd-say` on Linux),
so nothing is downloaded and nothing is sent anywhere. A machine with no speech synthesiser
is silently quiet; `familiar voice status` will tell you if that's what's happening.

## Counting what you fix

`familiar shell install` adds a small block to your PowerShell profile and `.bashrc`. After that, every test, build, typecheck and lint run counts — **whoever runs it**: you in your terminal, Claude Code, Cursor, a VS Code task.

The block appends one line to a spool file using a shell builtin. It launches no program, so it costs nothing on every prompt, and it never touches your exit code. It only records check-shaped commands — not a second copy of your shell history, and never anything you paste on a command line. Remove it with `familiar shell uninstall`; your profile is backed up first either way.

### On Windows, check your execution policy

Windows will not load a PowerShell profile unless its execution policy allows it, and the
**default on Windows 10 and 11 is `Restricted`, which does not.** On such a machine the
profile is written correctly and then never runs — you get a security error on every new
shell and nothing is counted.

`familiar shell install` detects this and tells you. The fix needs no admin rights:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`RemoteSigned` still requires a signature on anything downloaded from the internet; it only
trusts scripts written locally. Check where you stand with `Get-ExecutionPolicy -List` — if
`MachinePolicy` is set by your employer, the command above will not override it.

## How it grows

**Species** is chosen once, from your *past* git rhythm:

- **Sprout** — steady, regular commits
- **Ember** — bursty, big sessions
- **Wisp** — sporadic, scattered

**Branch** is chosen at level 15, from habits observed *since* you started:

| Branch | You get here by |
|---|---|
| 🦉 **Night Owl** | committing at 2am |
| 🧪 **Test Guardian** | shipping tests |
| ⚡ **Speed Demon** | merging fast |
| 🔥 **Firefighter** | fixing things that broke |
| 🛠️ **Refactorer** | going green without changing behaviour |
| 🎯 **One-Shot** | passing first try, consistently |
| 🪄 **Conjurer** | fixing things alongside an agent |

Three species × seven branches = **21 final forms**. The last four need something reporting check outcomes — the shell integration or the Claude Code hook. On git alone you get a complete but smaller tree, never a branch you can't reach.

A note on 🪄 Conjurer: it rewards *fixes made with an agent*, and a fix is worth exactly the same either way. Using an AI tool more can never earn you more XP — only fixing more things can.

## Privacy

Everything is read from **local git** and **local hooks**. Nothing leaves your machine, no API is called, and no credentials are needed — so your private-repo commits fully count.

State lives in `~/.familiar/`:

```text
events.jsonl   append-only log of everything that happened
shell.log      spool your shell appends check outcomes to
config.json    species, tone, voice, registered repos
cursor.json    last-scanned commit per repo, shell spool offset
error.log      anything a hook swallowed
```

Your level is **derived** from the event log every time it's read, never stored. Delete `config.json` and you lose settings; you never lose history. Change the XP rules and every past event re-scores correctly on the next read, with no migration.

### One honest caveat

`CLAUDECODE=1` is inherited by terminals launched from a Claude Code session, including VS Code's integrated terminal. Commands **you** type there may be attributed to the agent — there's no way to tell "inherited the variable" from "the agent ran this." Conjurer is slightly generous in that setup. It affects which branch you lean toward, never how much anything is worth.

## License

MIT
