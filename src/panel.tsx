import {
  atom,
  Badge,
  Button,
  Code,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  Row,
  Spinner,
  Stack,
  Text,
  plugin,
  read,
  set,
  type PanelContext,
} from 'orca'
import type { AccountRow, AccountsState, LaunchTool } from './protocol'

const state = atom<AccountsState | null>(null)
const error = atom<string | null>(null)
const busy = atom<string | null>(null)

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(plugin.on('accounts.changed', (next) => set(state, next)))
  plugin.request('accounts.state', {}).then(
    (next) => set(state, next),
    (err: Error) => set(error, err.message),
  )
}

async function act(key: string, work: () => Promise<unknown>) {
  set(busy, key)
  set(error, null)
  try {
    await work()
  } catch (err) {
    set(error, (err as Error).message)
  } finally {
    set(busy, null)
  }
}

const launch = (tool: LaunchTool) => act(`launch:${tool}`, () => plugin.request('accounts.launch', { tool }))
const activate = (id: string) => act(`activate:${id}`, () => plugin.request('accounts.activate', { id }))
const setPolicy = (ids: string[]) => act('policy', async () => set(state, await plugin.request('accounts.setPolicy', { ids })))

/** The policy the buttons edit: the allowed rows in order; without a policy, every row. */
function policyIds(s: AccountsState): string[] {
  return s.rows.filter((r) => r.allowed).map((r) => r.id)
}

function allow(s: AccountsState, id: string) {
  // Allowing one account on a project without a policy starts a policy with just that one.
  return setPolicy(s.hasPolicy ? [...policyIds(s), id] : [id])
}

function remove(s: AccountsState, id: string) {
  return setPolicy(policyIds(s).filter((x) => x !== id))
}

function moveUp(s: AccountsState, id: string) {
  const ids = policyIds(s)
  const i = ids.indexOf(id)
  if (i <= 0) return Promise.resolve()
  ;[ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]
  return setPolicy(ids)
}

function AccountItem({ r, s, working }: { r: AccountRow; s: AccountsState; working: string | null }) {
  const locked = working !== null
  return (
    <ListItem title={r.id} description={`${r.provider} · ${r.who}`} icon={r.provider === 'claude' ? 'agent' : 'zap'} current={r.active}>
      <Row gap="xs" align="center" wrap>
        {r.active ? <Badge tone="accent">active in Orca</Badge> : null}
        {r.next ? <Badge tone="success">next</Badge> : null}
        {r.limitedUntil ? <Badge tone="danger">limited until {new Date(r.limitedUntil).toLocaleString()}</Badge> : null}
        {r.allowed && s.hasPolicy ? (
          <IconButton icon="collapse" label={`Move ${r.id} up`} tooltip="Move up in the fallback order" size="sm" variant="ghost" disabled={locked} onPress={() => void moveUp(s, r.id)} />
        ) : null}
        {r.allowed && s.hasPolicy ? (
          <Button size="sm" variant="ghost" icon="remove" disabled={locked} onPress={() => void remove(s, r.id)}>
            Remove
          </Button>
        ) : null}
        {!r.allowed || !s.hasPolicy ? (
          <Button size="sm" variant="ghost" icon="add" disabled={locked} onPress={() => void allow(s, r.id)}>
            {s.hasPolicy ? 'Allow' : 'Allow only this'}
          </Button>
        ) : null}
        {r.selectable && !r.active ? (
          <Button size="sm" variant="ghost" icon="check" disabled={locked} onPress={() => void activate(r.id)}>
            {working === `activate:${r.id}` ? 'Switching…' : 'Make active'}
          </Button>
        ) : null}
      </Row>
    </ListItem>
  )
}

export default function Panel() {
  const s = read(state)
  const err = read(error)
  const working = read(busy)

  if (!s) {
    return err ? <EmptyState title="raygent accounts unavailable" description={err} icon="warning" /> : <Spinner label="Reading accounts" />
  }
  if (!s.workspace) {
    return <EmptyState title="No workspace focused" description="Open a workspace to see which accounts it may use." icon="folder" />
  }

  const allowed = s.rows.filter((r) => r.allowed)
  const others = s.rows.filter((r) => !r.allowed)
  const free = allowed.filter((r) => !r.limitedUntil)
  const hasGemini = allowed.some((r) => r.provider === 'gemini')

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Heading level={2}>{s.workspace.name}</Heading>
          <Badge tone={s.hasPolicy ? 'accent' : 'neutral'}>{s.hasPolicy ? 'policy' : 'no policy'}</Badge>
        </Row>
        <Text muted size="xs" truncate>
          {s.workspace.path}
        </Text>
      </Stack>

      {err ? (
        <Text tone="danger" size="sm">
          {err}
        </Text>
      ) : null}

      {s.rows.length === 0 ? (
        <EmptyState title="No accounts" description="Register your logins first." icon="agent">
          <Code>raygent accounts discover</Code>
        </EmptyState>
      ) : (
        <Stack gap="sm">
          <List label={s.hasPolicy ? 'Allowed, in fallback order' : 'Every registered account (no policy)'}>
            {allowed.map((r) => (
              <AccountItem r={r} s={s} working={working} />
            ))}
          </List>
          {others.length > 0 ? (
            <List label="Not allowed here">
              {others.map((r) => (
                <AccountItem r={r} s={s} working={working} />
              ))}
            </List>
          ) : null}
          {s.hasPolicy ? (
            <Row>
              <Button size="sm" variant="ghost" icon="close" disabled={working !== null} onPress={() => void setPolicy([])}>
                Clear policy (allow every account)
              </Button>
            </Row>
          ) : null}
        </Stack>
      )}

      <Row gap="xs" wrap>
        <Button icon="terminal" tone="accent" disabled={working !== null || !free.some((r) => r.provider === 'claude')} onPress={() => void launch('claude')}>
          {working === 'launch:claude' ? 'Opening…' : 'Open terminal: raygent claude'}
        </Button>
        {hasGemini ? (
          <Button icon="terminal" variant="ghost" disabled={working !== null || !free.some((r) => r.provider === 'gemini')} onPress={() => void launch('gemini')}>
            {working === 'launch:gemini' ? 'Opening…' : 'raygent gemini'}
          </Button>
        ) : null}
      </Row>

      <Text muted size="xs">
        {s.hasPolicy
          ? s.enforce
            ? 'New Claude tabs in this workspace launch under the "next" account.'
            : 'Enforcement is off in Settings: new tabs use the Orca-active account.'
          : 'No policy: new tabs use the Orca-active account.'}{' '}
        The same policy is what <Code>raygent accounts allow</Code> writes. Source: {s.file}
      </Text>
    </Stack>
  )
}
