import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AccountRow, AccountsState, LaunchTool } from './protocol'

// Reads the registry the raygent CLI maintains (`raygent accounts ...`) and
// answers "which account may this workspace use" for the panel and the status
// bar. The file holds config dir paths and env var names, never tokens.
//
// Two ways to switch: the agent.launch.before hook sets CLAUDE_CONFIG_DIR for
// a launch in a workspace that has a policy (setting `enforce`), and
// `accounts.activate` runs `orca account select` so Orca's own active account
// changes for every later launch.

interface Account {
  id: string
  provider: string
  configDir?: string
  env?: Record<string, string>
  email?: string
  org?: string
  limitedUntil?: string
}

interface AccountsFile {
  accounts: Account[]
  projects: Record<string, string[]>
}

const PROVIDERS = new Set(['claude', 'gemini'])
const run = promisify(execFile)

export function accountsPath(): string {
  return process.env.RAYGENT_ACCOUNTS_FILE ?? path.join(os.homedir(), '.raygent', 'accounts.json')
}

// `none` turns the Orca account features off (tests, or a host without the CLI).
function orcaCli(): string | null {
  const cli = process.env.RAYGENT_ORCA_CLI ?? 'orca'
  return cli === 'none' ? null : cli
}

// Same rule as raygent's normalizePath: policy keys compare case-insensitively on Windows.
export function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function readAccountsFile(file: string): AccountsFile {
  const empty: AccountsFile = { accounts: [], projects: {} }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AccountsFile>
    if (parsed === null || typeof parsed !== 'object') return empty
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((a): a is Account => !!a && typeof a === 'object' && typeof a.id === 'string' && PROVIDERS.has(a.provider))
      : []
    const projects: Record<string, string[]> = {}
    if (parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
      for (const [key, ids] of Object.entries(parsed.projects)) {
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) projects[key] = ids
      }
    }
    return { accounts, projects }
  } catch {
    return empty
  }
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`
}

function who(a: Account): string {
  if (a.email) return maskEmail(a.email)
  if (a.org) return a.org
  if (a.env) return Object.keys(a.env).join(', ')
  return a.configDir ?? ''
}

function isLimited(a: Account, now: number): boolean {
  if (!a.limitedUntil) return false
  const until = Date.parse(a.limitedUntil)
  return Number.isFinite(until) && until > now
}

/** The accounts a project may use, in order: its policy, or every account without one. */
export function allowedAccounts(file: AccountsFile, projectPath: string | null): { policy: string[] | undefined; accounts: Account[] } {
  const policy = projectPath ? file.projects[normalizePath(projectPath)] : undefined
  const accounts = policy
    ? policy.map((id) => file.accounts.find((a) => a.id === id)).filter((a): a is Account => a !== undefined)
    : file.accounts
  return { policy, accounts }
}

/** What a Claude launch in this project should run under, or null without a policy. */
export function launchConfigDir(file: AccountsFile, projectPath: string, now = Date.now()): string | null {
  const { policy, accounts } = allowedAccounts(file, projectPath)
  if (!policy) return null
  const claude = accounts.filter((a) => a.provider === 'claude' && a.configDir)
  // Every allowed account limited: still launch, on the first one, and let
  // Claude show its own limit message. The user chose never to block a launch.
  const pick = claude.find((a) => !isLimited(a, now)) ?? claude[0]
  return pick?.configDir ?? null
}

interface OrcaClaudeAccount {
  id: string
  home: string
}

export function computeRows(
  file: AccountsFile,
  projectPath: string | null,
  orca: { accounts: OrcaClaudeAccount[]; activeId: string | null },
  now = Date.now()
): { hasPolicy: boolean; rows: AccountRow[] } {
  const { policy, accounts } = allowedAccounts(file, projectPath)
  const nextByProvider = new Set<string>()
  const rows = accounts.map((a) => {
    const limited = isLimited(a, now)
    let next = false
    if (!limited && !nextByProvider.has(a.provider)) {
      nextByProvider.add(a.provider)
      next = true
    }
    const managed = a.configDir ? orca.accounts.find((o) => normalizePath(o.home) === normalizePath(a.configDir as string)) : undefined
    return {
      id: a.id,
      provider: a.provider,
      who: who(a),
      limitedUntil: limited ? (a.limitedUntil as string) : null,
      next,
      active: managed !== undefined && managed.id === orca.activeId,
      selectable: managed !== undefined,
    }
  })
  return { hasPolicy: policy !== undefined, rows }
}

type Workspace = { id: string; name: string; path: string }

let watcher: fs.FSWatcher | undefined
let watchTimer: NodeJS.Timeout | undefined

export function deactivate() {
  clearTimeout(watchTimer)
  watcher?.close()
  watcher = undefined
}

export default function activate(orca: OrcaWorkerApi) {
  let workspace: Workspace | null = null
  let enforce = true
  // workspaceId -> path, so the launch hook decides without awaiting the host.
  const workspacePaths = new Map<string, string>()
  let orcaAccounts: { accounts: OrcaClaudeAccount[]; activeId: string | null } = { accounts: [], activeId: null }

  async function refreshWorkspaces(): Promise<void> {
    const { workspaces } = await orca.host.call('workspace.list')
    workspacePaths.clear()
    for (const w of workspaces) workspacePaths.set(w.id, w.path)
  }

  // readContext has no path or id, so the focused workspace is matched against
  // workspace.list by display name (and branch when both sides have one).
  async function focusedWorkspace(): Promise<Workspace | null> {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx) return null
    const { workspaces } = await orca.host.call('workspace.list')
    workspacePaths.clear()
    for (const w of workspaces) workspacePaths.set(w.id, w.path)
    const byName = workspaces.filter((w) => w.name === ctx.displayName)
    const match = byName.find((w) => !ctx.branch || !w.branch || w.branch === ctx.branch) ?? byName[0]
    return match ? { id: match.id, name: match.name, path: match.path } : null
  }

  async function refreshOrcaAccounts(): Promise<void> {
    const cli = orcaCli()
    if (!cli) return
    try {
      const { stdout } = await run(cli, ['account', 'list', '--json'], { windowsHide: true })
      const parsed = JSON.parse(stdout) as { result?: { claude?: { accounts?: { id: string; home: string }[]; activeAccountId?: string | null } } }
      const claude = parsed.result?.claude
      orcaAccounts = {
        accounts: (claude?.accounts ?? []).filter((a) => typeof a.id === 'string' && typeof a.home === 'string').map((a) => ({ id: a.id, home: a.home })),
        activeId: claude?.activeAccountId ?? null,
      }
    } catch (err) {
      orca.log(`orca account list failed: ${(err as Error).message}`)
    }
  }

  async function readEnforce(): Promise<void> {
    try {
      const value = await orca.settings.get('enforce')
      enforce = value !== false
    } catch (err) {
      orca.log(`settings.get failed, enforcing by default: ${(err as Error).message}`)
    }
  }

  function compute(): AccountsState {
    const file = accountsPath()
    try {
      const registry = readAccountsFile(file)
      const { hasPolicy, rows } = computeRows(registry, workspace?.path ?? null, orcaAccounts)
      return { workspace, hasPolicy, rows, enforce, file, error: null }
    } catch (err) {
      return { workspace, hasPolicy: false, rows: [], enforce, file, error: (err as Error).message }
    }
  }

  async function updateStatusBar(state: AccountsState): Promise<void> {
    let text: string
    let tone: 'neutral' | 'accent' | 'warning' | 'danger' = 'neutral'
    if (!state.workspace) {
      text = 'raygent: no workspace'
    } else if (state.rows.length === 0) {
      text = 'raygent: no accounts'
      tone = 'warning'
    } else {
      const claude = state.rows.filter((r) => r.provider === 'claude')
      // Orca caps status bar text at 64 chars; without a policy the full
      // registry would not fit, and "any" is the real message anyway.
      text = state.hasPolicy
        ? state.rows.map((r) => (r.limitedUntil ? `${r.id}⊘` : r.id)).join(' → ')
        : `raygent: any of ${state.rows.length}`
      if (text.length > 64) text = `${text.slice(0, 63)}…`
      if (claude.length > 0 && claude.every((r) => r.limitedUntil)) tone = 'danger'
      else if (state.rows.some((r) => r.limitedUntil)) tone = 'warning'
      else if (state.hasPolicy) tone = 'accent'
    }
    const tooltip = state.workspace
      ? `${state.workspace.path}\n${state.hasPolicy ? (state.enforce ? 'policy, applied to launches' : 'policy, shown only') : 'no policy: every account allowed'}`
      : 'raygent accounts'
    try {
      await orca.host.call('statusBar.update', { id: 'accounts', text, tone, tooltip })
    } catch (err) {
      orca.log(`statusBar.update failed: ${(err as Error).message}`)
    }
  }

  async function publish(): Promise<AccountsState> {
    try {
      workspace = await focusedWorkspace()
    } catch (err) {
      orca.log(`workspace lookup failed: ${(err as Error).message}`)
      workspace = null
    }
    await refreshOrcaAccounts()
    const state = compute()
    orca.panels.post('accounts.changed', state)
    await updateStatusBar(state)
    return state
  }

  orca.panels.handle('accounts.state', async () => publish())

  orca.panels.handle('accounts.launch', async ({ tool }: { tool: LaunchTool }) => {
    if (!workspace) {
      workspace = await focusedWorkspace()
      if (!workspace) throw new Error('no focused workspace')
    }
    return orca.host.call('terminal.create', {
      workspaceId: workspace.id,
      title: `raygent ${tool}`,
      command: `raygent ${tool}`,
    })
  })

  orca.panels.handle('accounts.activate', async ({ id }: { id: string }) => {
    const cli = orcaCli()
    if (!cli) throw new Error('the orca CLI is not available here')
    const account = readAccountsFile(accountsPath()).accounts.find((a) => a.id === id)
    if (!account?.configDir) throw new Error(`'${id}' is not a Claude account`)
    await refreshOrcaAccounts()
    const managed = orcaAccounts.accounts.find((o) => normalizePath(o.home) === normalizePath(account.configDir as string))
    if (!managed) throw new Error(`Orca does not manage '${id}' (its config dir is not an Orca profile)`)
    await run(cli, ['account', 'select', '--agent', 'claude', '--account', managed.id, '--json'], { windowsHide: true })
    await publish()
    return { active: id }
  })

  orca.hooks.on('agent.launch.before', (event, next) => {
    if (event.agent !== 'claude' || !enforce || !event.workspaceId) return
    const projectPath = workspacePaths.get(event.workspaceId)
    if (!projectPath) return
    const configDir = launchConfigDir(readAccountsFile(accountsPath()), projectPath)
    if (!configDir) return
    orca.log(`launch in ${projectPath}: CLAUDE_CONFIG_DIR=${configDir}`)
    return next({ ...event, env: { ...event.env, CLAUDE_CONFIG_DIR: configDir } })
  })

  orca.commands.register('refresh', async () => {
    const state = await publish()
    return state.rows.length ? state.rows.map((r) => r.id).join(' → ') : 'no accounts registered (raygent accounts discover)'
  })

  orca.events.on('workspace.changed', () => {
    void publish()
  })
  orca.events.on('workspace.created', () => {
    void refreshWorkspaces()
  })
  orca.events.on('workspace.removed', ({ workspaceId }) => {
    workspacePaths.delete(workspaceId)
  })

  orca.settings.onDidChange(() => {
    void readEnforce().then(publish)
  })

  // The CLI and the Claude Code hooks rewrite the file; pick those edits up.
  const dir = path.dirname(accountsPath())
  deactivate()
  if (fs.existsSync(dir)) {
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (name && name !== path.basename(accountsPath())) return
        clearTimeout(watchTimer)
        watchTimer = setTimeout(() => void publish(), 300)
        watchTimer.unref()
      })
      watcher.unref() // never keep the worker (or a test run) alive on its own
    } catch (err) {
      orca.log(`fs.watch failed, the panel refreshes on workspace changes only: ${(err as Error).message}`)
    }
  }

  void readEnforce()
    .then(refreshWorkspaces)
    .catch((err: Error) => orca.log(`startup: ${err.message}`))
    .then(publish)
}
