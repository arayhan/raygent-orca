import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AccountRow, AccountsState, LaunchTool } from './protocol'

// Reads the registry the raygent CLI maintains (`raygent accounts ...`) and
// answers "which account may this workspace use" for the panel and the status
// bar. The file holds config dir paths and env var names, never tokens.

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

export function accountsPath(): string {
  return process.env.RAYGENT_ACCOUNTS_FILE ?? path.join(os.homedir(), '.raygent', 'accounts.json')
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

export function computeRows(file: AccountsFile, projectPath: string | null, now = Date.now()): { hasPolicy: boolean; rows: AccountRow[] } {
  const policy = projectPath ? file.projects[normalizePath(projectPath)] : undefined
  const accounts = policy
    ? policy.map((id) => file.accounts.find((a) => a.id === id)).filter((a): a is Account => a !== undefined)
    : file.accounts
  const nextByProvider = new Set<string>()
  const rows = accounts.map((a) => {
    const limited = isLimited(a, now)
    let next = false
    if (!limited && !nextByProvider.has(a.provider)) {
      nextByProvider.add(a.provider)
      next = true
    }
    return { id: a.id, provider: a.provider, who: who(a), limitedUntil: limited ? (a.limitedUntil as string) : null, next }
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
  let current: AccountsState = { workspace: null, hasPolicy: false, rows: [], file: accountsPath(), error: null }
  let workspace: Workspace | null = null

  // readContext has no path or id, so the focused workspace is matched against
  // workspace.list by display name (and branch when both sides have one).
  async function focusedWorkspace(): Promise<Workspace | null> {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx) return null
    const { workspaces } = await orca.host.call('workspace.list')
    const byName = workspaces.filter((w) => w.name === ctx.displayName)
    const match = byName.find((w) => !ctx.branch || !w.branch || w.branch === ctx.branch) ?? byName[0]
    return match ? { id: match.id, name: match.name, path: match.path } : null
  }

  function compute(): AccountsState {
    const file = accountsPath()
    try {
      const registry = readAccountsFile(file)
      const { hasPolicy, rows } = computeRows(registry, workspace?.path ?? null)
      return { workspace, hasPolicy, rows, file, error: null }
    } catch (err) {
      return { workspace, hasPolicy: false, rows: [], file, error: (err as Error).message }
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
      text = state.rows.map((r) => (r.limitedUntil ? `${r.id}⊘` : r.id)).join(' → ')
      if (claude.length > 0 && claude.every((r) => r.limitedUntil)) tone = 'danger'
      else if (state.rows.some((r) => r.limitedUntil)) tone = 'warning'
      else if (state.hasPolicy) tone = 'accent'
    }
    const tooltip = state.workspace
      ? `${state.workspace.path}\n${state.hasPolicy ? 'policy' : 'no policy: every account allowed'}`
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
    current = compute()
    orca.panels.post('accounts.changed', current)
    await updateStatusBar(current)
    return current
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

  orca.commands.register('refresh', async () => {
    const state = await publish()
    return state.rows.length ? state.rows.map((r) => r.id).join(' → ') : 'no accounts registered (raygent accounts discover)'
  })

  orca.events.on('workspace.changed', () => {
    void publish()
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

  void publish()
}
