// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { AccountsState } from './protocol'
import * as panel from './panel'

const state: AccountsState = {
  workspace: { id: 'w1', name: 'raygent', path: 'D:\\code\\raygent' },
  hasPolicy: true,
  rows: [
    { id: 'personal', provider: 'claude', who: 'r***@gmail.com', limitedUntil: '2026-11-12T12:30:00.000Z', next: false },
    { id: 'sendtrack', provider: 'claude', who: 's***@gmail.com', limitedUntil: null, next: true },
    { id: 'gemini', provider: 'gemini', who: 'GEMINI_API_KEY', limitedUntil: null, next: true },
  ],
  file: 'C:\\Users\\me\\.raygent\\accounts.json',
  error: null,
}

test('lists the policy with next and limited badges', async () => {
  const host = mockHost({ requests: { 'accounts.state': state } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'raygent' }), 'workspace name')
  assert.ok(view.find({ text: 'policy' }), 'policy badge')
  assert.ok(view.find({ label: 'personal' }), 'first row')
  assert.ok(view.find({ text: 'next' }), 'next badge on the first free account')
  assert.ok(view.find({ text: /limited until/ }), 'limited badge')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('launch button asks the worker for a terminal', async () => {
  let launched: unknown
  const host = mockHost({
    requests: {
      'accounts.state': state,
      'accounts.launch': (input) => {
        launched = input
        return { terminalId: 't1' }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Open terminal: raygent claude' })
  await view.settled()
  assert.deepEqual(launched, { tool: 'claude' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the empty state without a focused workspace', async () => {
  const host = mockHost({ requests: { 'accounts.state': { ...state, workspace: null } } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No workspace focused' }))
  await view.unmount()
})

test('a worker post replaces the state', async () => {
  const host = mockHost({ requests: { 'accounts.state': state } })
  const view = await mount(panel, { host })
  await view.post('accounts.changed', { ...state, hasPolicy: false, rows: [] })
  assert.ok(view.find({ label: 'No accounts' }))
  await view.unmount()
})
