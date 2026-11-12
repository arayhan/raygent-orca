import {
  atom,
  Badge,
  Button,
  Code,
  EmptyState,
  Heading,
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
import type { AccountsState, LaunchTool } from './protocol'

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

  const hasGemini = s.rows.some((r) => r.provider === 'gemini')
  const free = s.rows.filter((r) => !r.limitedUntil)

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
        <EmptyState
          title="No accounts"
          description={s.hasPolicy ? 'The policy names accounts that are no longer registered.' : 'Register your logins first.'}
          icon="agent"
        >
          <Code>raygent accounts discover</Code>
        </EmptyState>
      ) : (
        <List label={s.hasPolicy ? 'Allowed, in fallback order' : 'Every registered account (no policy)'}>
          {s.rows.map((r) => (
            <ListItem title={r.id} description={`${r.provider} · ${r.who}`} icon={r.provider === 'claude' ? 'agent' : 'zap'} current={r.active}>
              <Row gap="xs" align="center" wrap>
                {r.active ? <Badge tone="accent">active in Orca</Badge> : null}
                {r.next ? <Badge tone="success">next</Badge> : null}
                {r.limitedUntil ? <Badge tone="danger">limited until {new Date(r.limitedUntil).toLocaleString()}</Badge> : null}
                {r.selectable && !r.active ? (
                  <Button size="sm" variant="ghost" icon="check" disabled={working !== null} onPress={() => void activate(r.id)}>
                    {working === `activate:${r.id}` ? 'Switching…' : 'Make active'}
                  </Button>
                ) : null}
              </Row>
            </ListItem>
          ))}
        </List>
      )}

      <Row gap="xs" wrap>
        <Button
          icon="terminal"
          tone="accent"
          disabled={working !== null || !free.some((r) => r.provider === 'claude')}
          onPress={() => void launch('claude')}
        >
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
        Change with <Code>raygent accounts allow &lt;id…&gt;</Code> or <Code>raygent accounts limit &lt;id&gt;</Code>. Source: {s.file}
      </Text>
    </Stack>
  )
}
