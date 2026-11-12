// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { AccountsState } from './protocol'
import * as panel from './panel'

const state: AccountsState = {
  workspace: { id: 'w1', name: 'raygent', path: 'D:\\code\\raygent' },
  hasPolicy: true,
  enforce: true,
  rows: [
    { id: 'personal', provider: 'claude', who: 'r***@gmail.com', limitedUntil: '2026-11-12T12:30:00.000Z', next: false, active: true, selectable: true },
    { id: 'sendtrack', provider: 'claude', who: 's***@gmail.com', limitedUntil: null, next: true, active: false, selectable: true },
    { id: 'gemini', provider: 'gemini', who: 'GEMINI_API_KEY', limitedUntil: null, next: true, active: false, selectable: false },
  ],
  file: 'C:\\Users\\me\\.raygent\\accounts.json',
  error: null,
}

test('lists the policy with active, next and limited badges', async () => {
  const host = mockHost({ requests: { 'accounts.state': state } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'raygent' }), 'workspace name')
  assert.ok(view.find({ text: 'policy' }), 'policy badge')
  assert.ok(view.find({ label: 'personal' }), 'first row')
  assert.ok(view.find({ text: 'active in Orca' }), 'active badge')
  assert.ok(view.find({ text: 'next' }), 'next badge on the first free account')
  assert.ok(view.find({ text: /limited until/ }), 'limited badge')
  // one Make active button: sendtrack (personal is active, gemini is not an Orca account)
  assert.equal(view.findAll({ text: 'Make active' }).length, 1)
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

test('Make active asks the worker to select that account', async () => {
  let activated: unknown
  const host = mockHost({
    requests: {
      'accounts.state': state,
      'accounts.activate': (input) => {
        activated = input
        return { active: input.id }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Make active' })
  await view.settled()
  assert.deepEqual(activated, { id: 'sendtrack' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a failed activate shows the reason and keeps the list', async () => {
  const host = mockHost({
    requests: {
      'accounts.state': state,
      'accounts.activate': () => {
        throw new Error('the orca CLI is not available here')
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Make active' })
  await view.settled()
  assert.ok(view.find({ text: /orca CLI is not available/ }))
  assert.ok(view.find({ label: 'personal' }))
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
