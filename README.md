# raygent-orca

An [Orca](https://orca.app) plugin for the [raygent](https://github.com/arayhan/raygent) account policy. It shows, for the focused workspace, which AI accounts the project may use, in fallback order, which of them is rate-limited, which one is Orca's active account, and which one a launch gets next. A status bar item carries the same summary; pressing it refreshes.

The plugin reads `~/.raygent/accounts.json`, the file the raygent CLI maintains. It never sees a token: a Claude account is a `CLAUDE_CONFIG_DIR` folder that is already logged in, a Gemini account is the name of an env var.

## Switching accounts

Two ways, both in the panel:

- **Per launch, automatic.** When Orca starts Claude in a workspace that has a policy, the plugin's `agent.launch.before` hook sets `CLAUDE_CONFIG_DIR` to the first allowed account that is not rate-limited (the row marked `next`). If every allowed account is limited it still launches, on the first one, and Claude shows its own limit message. The setting *Pick the account per workspace policy* turns this off; then the policy is only shown.
- **Make active.** The button on a row runs `orca account select --agent claude --account <id>`, so Orca's own active account changes for every later launch, in any workspace. Only accounts Orca manages (its profiles) get the button.

A Claude session that is already open keeps its account. Switching means a new tab; `--continue` only finds sessions inside the same account folder.

## What it needs

- `workspace:read`, to know which workspace is focused and map launches to projects.
- `terminal:send`, for the button that opens a terminal running `raygent claude` (or `raygent gemini`).
- `settings:own`, for the enforce toggle.
- `raygent` and `orca` on the PATH of the machine Orca runs on (`npm i -g raygent`).

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
