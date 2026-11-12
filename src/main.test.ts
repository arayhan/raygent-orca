// `orca plugin test .` runs this in Node against a mock Orca host.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as worker from './main'
import { computeRows, readAccountsFile } from './main'

const project = path.join(os.tmpdir(), 'raygent-orca-project')

function withRegistry(contents: unknown, run: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raygent-orca-'))
  const file = path.join(dir, 'accounts.json')
  fs.writeFileSync(file, JSON.stringify(contents))
  process.env.RAYGENT_ACCOUNTS_FILE = file
  return run().finally(() => {
    delete process.env.RAYGENT_ACCOUNTS_FILE
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

test('computeRows follows the policy order and marks the first free account as next', () => {
  const file = readAccountsFile('/nonexistent')
  assert.deepEqual(file, { accounts: [], projects: {} })

  const withPolicy = { ...registry, projects: { [project.toLowerCase()]: ['personal', 'backup'] } }
  const r = computeRows(withPolicy as never, project.toUpperCase())
  assert.equal(r.hasPolicy, process.platform === 'win32')
  if (process.platform === 'win32') {
    assert.deepEqual(r.rows.map((x) => [x.id, x.next, x.limitedUntil !== null]), [
      ['personal', false, true],
      ['backup', true, false],
    ])
  }
  const none = computeRows(registry as never, 'D:\\elsewhere')
  assert.equal(none.hasPolicy, false)
  assert.equal(none.rows.length, 4)
  assert.deepEqual(none.rows.filter((x) => x.next).map((x) => x.id), ['office', 'gemini'])
})

test('the worker answers accounts.state for the focused workspace and updates the status bar', () =>
  withRegistry({ ...registry, projects: { [process.platform === 'win32' ? project.toLowerCase() : project]: ['personal', 'backup'] } }, async () => {
    const host = mockHost({
      capabilities: ['workspace:read', 'terminal:send'],
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
    const w = await mountWorker(worker, { host, events: ['workspace.changed'], commands: ['refresh'] })
    const state = (await w.request('accounts.state', {})) as { workspace: { id: string } | null; hasPolicy: boolean; rows: { id: string }[] }
    assert.equal(state.workspace?.id, 'w1')
    assert.equal(state.hasPolicy, true)
    assert.deepEqual(state.rows.map((r) => r.id), ['personal', 'backup'])

    const bar = host.callsOf('statusBar.update').at(-1) as { text: string; tone: string }
    assert.equal(bar.text, 'personal⊘ → backup')
    assert.equal(bar.tone, 'warning')

    const launched = (await w.request('accounts.launch', { tool: 'claude' })) as { terminalId: string }
    assert.equal(launched.terminalId, 't9')
    const create = host.callsOf('terminal.create').at(-1) as { workspaceId: string; command: string }
    assert.deepEqual([create.workspaceId, create.command], ['w1', 'raygent claude'])

    assert.equal(await w.command('refresh'), 'personal → backup')
    assert.deepEqual(host.refusals, [])
    await w.deactivate()
  }))
