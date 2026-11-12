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

// "limited · 02:10" today, "limited · 13 Nov 02:10" otherwise: the badge has no room for a full timestamp.
function limitLabel(iso: string): string {
  const t = new Date(iso)
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = t.toDateString() === new Date().toDateString()
  return sameDay ? `limited · ${time}` : `limited · ${t.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

function AccountItem({ r, s, working, first }: { r: AccountRow; s: AccountsState; working: string | null; first: boolean }) {
  const locked = working !== null
  const badges = [
    r.active ? <Badge tone="accent">active</Badge> : null,
    r.next ? <Badge tone="success">next</Badge> : null,
    r.limitedUntil ? <Badge tone="danger">{limitLabel(r.limitedUntil)}</Badge> : null,
  ].filter(Boolean)
  return (
    <ListItem title={r.id} description={`${r.provider} · ${r.who}`} icon={r.provider === 'claude' ? 'agent' : 'zap'} current={r.active}>
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" wrap>
          {badges}
        </Row>
        <Row gap="xs">
          {r.allowed && s.hasPolicy && !first ? (
            <IconButton icon="collapse" label={`Move ${r.id} up`} tooltip="Earlier in the fallback order" size="sm" variant="ghost" disabled={locked} onPress={() => void moveUp(s, r.id)} />
          ) : null}
          {r.allowed && s.hasPolicy ? (
            <IconButton icon="remove" label={`Remove ${r.id}`} tooltip="Not allowed in this project" size="sm" variant="ghost" disabled={locked} onPress={() => void remove(s, r.id)} />
          ) : (
            <IconButton
              icon="add"
              label={`Allow ${r.id}`}
              tooltip={s.hasPolicy ? 'Allow in this project (last in the fallback order)' : 'Start a policy with only this account'}
              size="sm"
              variant="ghost"
              disabled={locked}
              onPress={() => void allow(s, r.id)}
            />
          )}
          {r.selectable && !r.active ? (
            <IconButton icon="check" label={`Make ${r.id} active`} tooltip="Make it Orca's active account" size="sm" variant="ghost" disabled={locked} onPress={() => void activate(r.id)} />
          ) : null}
        </Row>
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
  const limited = allowed.filter((r) => r.limitedUntil)
  const firstAllowed = allowed[0]?.id
  const hasGemini = allowed.some((r) => r.provider === 'gemini')
  const launchHint = s.hasPolicy
    ? s.enforce
      ? 'New Claude tabs here open as the "next" account.'
      : 'Enforcement is off in Settings: new tabs use the active account.'
    : 'No policy: new tabs use the active account. Allow one to start a policy.'

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Row justify="between" align="center">
          {/* Orca's display name is often the branch; the folder is what the policy is keyed on. */}
          <Heading level={2}>{s.workspace.path.split(/[\\/]/).filter(Boolean).pop() ?? s.workspace.name}</Heading>
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
          {free.length > 0 ? (
            <List label={s.hasPolicy ? 'Ready, in fallback order' : 'Ready (no policy: any of these)'}>
              {free.map((r) => (
                <AccountItem r={r} s={s} working={working} first={r.id === firstAllowed} />
              ))}
            </List>
          ) : (
            <EmptyState title="Nothing ready" description="Every allowed account is rate-limited; the next launch uses the first one anyway." icon="warning" />
          )}
          {limited.length > 0 ? (
            <List label="Limited, until reset">
              {limited.map((r) => (
                <AccountItem r={r} s={s} working={working} first={r.id === firstAllowed} />
              ))}
            </List>
          ) : null}
          {others.length > 0 ? (
            <List label="Not allowed here">
              {others.map((r) => (
                <AccountItem r={r} s={s} working={working} first={false} />
              ))}
            </List>
          ) : null}
        </Stack>
      )}

      <Stack gap="xs">
        <Row gap="xs" wrap>
          <Button icon="terminal" tone="accent" disabled={working !== null || !free.some((r) => r.provider === 'claude')} onPress={() => void launch('claude')}>
            {working === 'launch:claude' ? 'Opening…' : 'raygent claude'}
          </Button>
          {hasGemini ? (
            <Button icon="terminal" variant="ghost" disabled={working !== null || !free.some((r) => r.provider === 'gemini')} onPress={() => void launch('gemini')}>
              {working === 'launch:gemini' ? 'Opening…' : 'raygent gemini'}
            </Button>
          ) : null}
          {s.hasPolicy ? (
            <Button icon="close" variant="ghost" disabled={working !== null} onPress={() => void setPolicy([])}>
              Clear policy
            </Button>
          ) : null}
        </Row>
        <Text muted size="xs">
          {launchHint}
        </Text>
      </Stack>
    </Stack>
  )
}
