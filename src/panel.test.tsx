// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import type { AccountsState } from './protocol'
import * as panel from './panel'

const state: AccountsState = {
  workspace: { id: 'w1', name: 'raygent', path: 'D:\\code\\raygent' },
  hasPolicy: true,
  enforce: true,
  rows: [
    { id: 'personal', provider: 'claude', who: 'r***@gmail.com', limitedUntil: '2026-11-12T12:30:00.000Z', next: false, active: true, selectable: true, allowed: true },
    { id: 'sendtrack', provider: 'claude', who: 's***@gmail.com', limitedUntil: null, next: true, active: false, selectable: true, allowed: true },
    { id: 'office', provider: 'claude', who: 'o***@acme.com', limitedUntil: null, next: false, active: false, selectable: true, allowed: false },
    { id: 'gemini', provider: 'gemini', who: 'GEMINI_API_KEY', limitedUntil: null, next: false, active: false, selectable: false, allowed: false },
  ],
  file: 'C:\\Users\\me\\.raygent\\accounts.json',
  error: null,
}

test('lists allowed and not-allowed accounts with their badges and buttons', async () => {
  const host = mockHost({ requests: { 'accounts.state': state } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'raygent' }), 'workspace name')
  assert.ok(view.find({ text: 'policy' }), 'policy badge')
  assert.ok(view.find({ label: 'personal' }), 'allowed row')
  assert.ok(view.find({ label: 'office' }), 'not-allowed row is still listed')
  assert.ok(view.find({ text: 'active in Orca' }), 'active badge')
  assert.ok(view.find({ text: 'next' }), 'next badge on the first free allowed account')
  assert.ok(view.find({ text: /limited until/ }), 'limited badge')
  assert.equal(view.findAll({ text: 'Remove' }).length, 2, 'one Remove per allowed row')
  assert.equal(view.findAll({ text: 'Allow' }).length, 2, 'one Allow per not-allowed row')
  // Make active: sendtrack and office (personal is active, gemini is not an Orca account)
  assert.equal(view.findAll({ text: 'Make active' }).length, 2)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Allow, Remove, move up and Clear send the new policy to the worker', async () => {
  const sent: string[][] = []
  const host = mockHost({
    requests: {
      'accounts.state': state,
      'accounts.setPolicy': (input) => {
        sent.push(input.ids)
        return state
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Allow' }) // first not-allowed row: office
  await view.settled()
  await view.press({ text: 'Remove' }) // first allowed row: personal
  await view.settled()
  await view.press({ label: 'Move sendtrack up' })
  await view.settled()
  await view.press({ text: /Clear policy/ })
  await view.settled()
  assert.deepEqual(sent, [
    ['personal', 'sendtrack', 'office'],
    ['sendtrack'],
    ['sendtrack', 'personal'],
    [],
  ])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('without a policy, Allow starts one with just that account', async () => {
  const sent: string[][] = []
  const noPolicy = { ...state, hasPolicy: false, rows: state.rows.map((r) => ({ ...r, allowed: true })) }
  const host = mockHost({
    requests: {
      'accounts.state': noPolicy,
      'accounts.setPolicy': (input) => {
        sent.push(input.ids)
        return noPolicy
      },
    },
  })
  const view = await mount(panel, { host })
  assert.equal(view.findAll({ text: 'Remove' }).length, 0)
  await view.press({ text: 'Allow only this' })
  await view.settled()
  assert.deepEqual(sent, [['personal']])
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

test('a failed request shows the reason and keeps the list', async () => {
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
