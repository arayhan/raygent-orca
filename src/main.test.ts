// `orca plugin test .` runs this in Node against a mock Orca host.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as worker from './main'
import { computeRows, launchAccount, readAccountsFile, rewriteLaunchCommand, workspacePathFromId } from './main'

const project = path.join(os.tmpdir(), 'raygent-orca-project')

const envOf = (decision: unknown) => (decision as { event?: { env?: Record<string, string> } }).event?.env
const policyKey = process.platform === 'win32' ? project.toLowerCase() : project

function withRegistry(contents: unknown, run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raygent-orca-'))
  const file = path.join(dir, 'accounts.json')
  fs.writeFileSync(file, JSON.stringify(contents))
  process.env.RAYGENT_ACCOUNTS_FILE = file
  process.env.RAYGENT_ORCA_CLI = 'none' // never touch the real Orca accounts from a test
  return run().finally(() => {
    delete process.env.RAYGENT_ACCOUNTS_FILE
    delete process.env.RAYGENT_ORCA_CLI
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

const registry = {
  accounts: [
    { id: 'office', provider: 'claude', configDir: 'C:\\o', email: 'me@acme.com' },
    { id: 'personal', provider: 'claude', configDir: 'C:\\p', email: 'me@gmail.com', limitedUntil: '2999-01-01T00:00:00.000Z' },
    { id: 'backup', provider: 'claude', configDir: 'C:\\b', email: 'b@gmail.com' },
    { id: 'gemini', provider: 'gemini', env: { GEMINI_API_KEY: '$GEMINI_API_KEY' } },
  ],
  projects: {},
}
const noOrca = { accounts: [], activeId: null }

test('computeRows follows the policy order, marks next, active and selectable', () => {
  assert.deepEqual(readAccountsFile('/nonexistent'), { accounts: [], projects: {} })

  const withPolicy = { ...registry, projects: { [policyKey]: ['personal', 'backup'] } }
  const orcaState = { accounts: [{ id: 'orca-b', home: 'c:\\B\\' }], activeId: 'orca-b' }
  const r = computeRows(withPolicy as never, project.toUpperCase(), orcaState)
  if (process.platform === 'win32') {
    assert.equal(r.hasPolicy, true)
    assert.deepEqual(
      r.rows.map((x) => [x.id, x.next, x.limitedUntil !== null, x.active, x.selectable]),
      [
        ['personal', false, true, false, false],
        ['backup', true, false, true, true],
      ]
    )
  }
  const none = computeRows(registry as never, 'D:\\elsewhere', noOrca)
  assert.equal(none.hasPolicy, false)
  assert.equal(none.rows.length, 4)
  assert.deepEqual(none.rows.filter((x) => x.next).map((x) => x.id), ['office', 'gemini'])
  assert.ok(none.rows.every((x) => !x.active && !x.selectable))
})

test('launchAccount skips limited accounts and falls back to the first one', () => {
  const file = { ...registry, projects: { [policyKey]: ['personal', 'backup'] } } as never
  assert.deepEqual(launchAccount(file, project), { id: 'backup', configDir: 'C:\\b' })
  const allLimited = {
    ...registry,
    accounts: registry.accounts.map((a) => (a.provider === 'claude' ? { ...a, limitedUntil: '2999-01-01T00:00:00.000Z' } : a)),
    projects: { [policyKey]: ['personal', 'backup'] },
  } as never
  assert.deepEqual(launchAccount(allLimited, project), { id: 'personal', configDir: 'C:\\p' })
  assert.equal(launchAccount(registry as never, project), null, 'no policy: leave the launch alone')
  assert.equal(launchAccount({ ...registry, projects: { [policyKey]: ['gemini'] } } as never, project), null)
})

test('launch helpers read Orca ids and rewrite only claude commands', () => {
  assert.equal(workspacePathFromId('5a57::D:/code/raygent'), 'D:/code/raygent')
  assert.equal(workspacePathFromId('folder-id'), undefined)
  assert.equal(rewriteLaunchCommand("claude '--dangerously-skip-permissions'", 'backup'), "raygent claude --account backup '--dangerously-skip-permissions'")
  assert.equal(rewriteLaunchCommand('claude', 'backup'), 'raygent claude --account backup')
  assert.equal(rewriteLaunchCommand('codex --full-auto', 'backup'), 'codex --full-auto')
  assert.equal(rewriteLaunchCommand('claude-foo', 'backup'), 'claude-foo')
})

test('the worker answers accounts.state, updates the status bar, and sets CLAUDE_CONFIG_DIR on launch', () =>
  withRegistry({ ...registry, projects: { [policyKey]: ['personal', 'backup'] } }, async () => {
    const host = mockHost({
      capabilities: ['workspace:read', 'terminal:send', 'settings:own'],
      settings: { enforce: true },
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'proj', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'w1', kind: 'worktree', name: 'proj', project: null, path: project, branch: 'main', hostId: null }],
          truncated: false,
        },
        'statusBar.update': { ok: true },
        'terminal.create': { terminalId: 't9' },
      },
    })
    const w = await mountWorker(worker, { host, events: ['workspace.changed', 'workspace.created', 'workspace.removed'], commands: ['refresh'], hooks: ['agent.launch.before'] })
    const state = (await w.request('accounts.state', {})) as { workspace: { id: string } | null; hasPolicy: boolean; enforce: boolean; rows: { id: string }[] }
    assert.equal(state.workspace?.id, 'w1')
    assert.equal(state.hasPolicy, true)
    assert.equal(state.enforce, true)
    assert.deepEqual(state.rows.map((r) => r.id), ['personal', 'backup'])

    const bar = host.callsOf('statusBar.update').at(-1) as { text: string; tone: string }
    assert.equal(bar.text, 'personal⊘ → backup')
    assert.equal(bar.tone, 'warning')

    const launch = { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree' as const, command: 'claude', env: { FOO: '1' } }
    const decision = await w.hooks.fire('agent.launch.before', launch)
    assert.equal(decision.kind, 'continue')
    assert.deepEqual(envOf(decision), { FOO: '1', CLAUDE_CONFIG_DIR: 'C:\\b' })
    assert.equal((decision as { event: { command: string } }).event.command, 'raygent claude --account backup')

    // Orca's real ids carry the path after `::`, even when the cache has not seen them
    const byId = await w.hooks.fire('agent.launch.before', { ...launch, workspaceId: `repo::${project}` })
    assert.deepEqual(envOf(byId), { FOO: '1', CLAUDE_CONFIG_DIR: 'C:\\b' })

    const other = await w.hooks.fire('agent.launch.before', { ...launch, agent: 'codex' })
    assert.deepEqual(envOf(other), { FOO: '1' }, 'other agents pass unchanged')

    const unknown = await w.hooks.fire('agent.launch.before', { ...launch, workspaceId: 'w-unknown' })
    assert.deepEqual(envOf(unknown), { FOO: '1' }, 'unknown workspace passes unchanged')

    const launched = (await w.request('accounts.launch', { tool: 'claude' })) as { terminalId: string }
    assert.equal(launched.terminalId, 't9')
    const create = host.callsOf('terminal.create').at(-1) as { workspaceId: string; command: string }
    assert.deepEqual([create.workspaceId, create.command], ['w1', 'raygent claude'])

    await assert.rejects(w.request('accounts.activate', { id: 'backup' }), /orca CLI is not available/)

    assert.equal(await w.command('refresh'), 'personal → backup')
    assert.deepEqual(host.refusals, [])
    await w.deactivate()
  }))

test('with enforce off the launch hook passes', () =>
  withRegistry({ ...registry, projects: { [policyKey]: ['backup'] } }, async () => {
    const host = mockHost({
      capabilities: ['workspace:read', 'terminal:send', 'settings:own'],
      settings: { enforce: false },
      results: {
        'workspace.readContext': null,
        'workspace.list': {
          workspaces: [{ id: 'w1', kind: 'worktree', name: 'proj', project: null, path: project, branch: 'main', hostId: null }],
          truncated: false,
        },
        'statusBar.update': { ok: true },
      },
    })
    const w = await mountWorker(worker, { host, events: ['workspace.changed'], commands: ['refresh'], hooks: ['agent.launch.before'] })
    await w.request('accounts.state', {})
    const launch = { agent: 'claude', workspaceId: 'w1', workspaceKind: 'worktree' as const, command: 'claude', env: {} }
    const decision = await w.hooks.fire('agent.launch.before', launch)
    assert.deepEqual(envOf(decision), {})
    await w.deactivate()
  }))
