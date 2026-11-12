# raygent-orca

An [Orca](https://orca.app) plugin for the [raygent](https://github.com/arayhan/raygent) account policy. It shows, for the focused workspace, which AI accounts the project may use, in fallback order, which of them is rate-limited, and which one `raygent claude` would pick next. A status bar item carries the same summary; pressing it refreshes.

The plugin only reads `~/.raygent/accounts.json`, the file the raygent CLI maintains. It never sees a token: a Claude account is a `CLAUDE_CONFIG_DIR` folder that is already logged in, a Gemini account is the name of an env var.

## What it needs

- `workspace:read`, to know which workspace is focused.
- `terminal:send`, for the one button: open a terminal in the workspace running `raygent claude` (or `raygent gemini`).
- `raygent` on the PATH of the machine Orca runs on (`npm i -g raygent`).

## Use

```text
raygent accounts discover                 # register your logins once
raygent accounts allow personal backup    # in a project: who may run here
```

Open the Raygent Accounts panel in the right sidebar. It updates when the focus moves or the registry changes (the CLI, or the Claude Code hooks `raygent accounts install-hooks` adds, rewrite it).

## Develop

```text
orca plugin dev watch . --check --shot ./.orca/shots --json
orca plugin test . --json
orca plugin check . --json
orca plugin validate . --json
```

No build step: Orca transpiles `src/*.ts(x)` as it loads them. `npx tsc -p .` type-checks.
