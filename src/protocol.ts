// Shared between the worker (src/main.ts) and the panel (src/panel.tsx).

export interface AccountRow {
  id: string
  provider: string
  /** Masked email, org or env var names: never a secret. */
  who: string
  /** ISO timestamp while the account is rate-limited, else null. */
  limitedUntil: string | null
  /** The account `raygent claude` (and the launch hook) would pick right now. */
  next: boolean
  /** Orca's active Claude account: the one a new tab gets without the hook. */
  active: boolean
  /** Whether "Make active" can target it (a Claude account Orca manages). */
  selectable: boolean
}

export interface AccountsState {
  workspace: { id: string; name: string; path: string } | null
  /** False when the project has no policy and every registered account is allowed. */
  hasPolicy: boolean
  rows: AccountRow[]
  /** The plugin setting: launches in a workspace with a policy get its account. */
  enforce: boolean
  /** Where the registry was read from, for the hint under the list. */
  file: string
  error: string | null
}

export type LaunchTool = 'claude' | 'gemini'

declare module 'orca' {
  interface PluginRequests {
    'accounts.state': { input: { refresh?: boolean }; output: AccountsState }
    'accounts.launch': { input: { tool: LaunchTool }; output: { terminalId: string } }
    'accounts.activate': { input: { id: string }; output: { active: string } }
  }
  interface PluginPanelEvents {
    'accounts.changed': AccountsState
  }
}
