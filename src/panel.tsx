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
const launching = atom<LaunchTool | null>(null)

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(plugin.on('accounts.changed', (next) => set(state, next)))
  plugin.request('accounts.state', {}).then(
    (next) => set(state, next),
    (err: Error) => set(error, err.message),
  )
}

async function launch(tool: LaunchTool) {
  set(launching, tool)
  try {
    await plugin.request('accounts.launch', { tool })
  } catch (err) {
    set(error, (err as Error).message)
  } finally {
    set(launching, null)
  }
}

export default function Panel() {
  const s = read(state)
  const err = read(error)
  const busy = read(launching)

  if (err) {
    return <EmptyState title="raygent accounts unavailable" description={err} icon="warning" />
  }
  if (!s) {
    return <Spinner label="Reading accounts" />
  }
  if (!s.workspace) {
    return <EmptyState title="No workspace focused" description="Open a workspace to see which accounts it may use." icon="folder" />
  }

  const hasGemini = s.rows.some((r) => r.provider === 'gemini')
  const allowed = s.rows.filter((r) => !r.limitedUntil)

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
            <ListItem title={r.id} description={`${r.provider} · ${r.who}`} icon={r.provider === 'claude' ? 'agent' : 'zap'}>
              <Row gap="xs">
                {r.next ? <Badge tone="success">next</Badge> : null}
                {r.limitedUntil ? <Badge tone="danger">limited until {new Date(r.limitedUntil).toLocaleString()}</Badge> : null}
              </Row>
            </ListItem>
          ))}
        </List>
      )}

      <Row gap="xs" wrap>
        <Button
          icon="terminal"
          tone="accent"
          disabled={busy !== null || !allowed.some((r) => r.provider === 'claude')}
          onPress={() => void launch('claude')}
        >
          {busy === 'claude' ? 'Opening…' : 'Open terminal: raygent claude'}
        </Button>
        {hasGemini ? (
          <Button
            icon="terminal"
            variant="ghost"
            disabled={busy !== null || !allowed.some((r) => r.provider === 'gemini')}
            onPress={() => void launch('gemini')}
          >
            {busy === 'gemini' ? 'Opening…' : 'raygent gemini'}
          </Button>
        ) : null}
      </Row>

      <Text muted size="xs">
        Change with <Code>raygent accounts allow &lt;id…&gt;</Code> or <Code>raygent accounts limit &lt;id&gt;</Code> in this workspace. Source: {s.file}
      </Text>
    </Stack>
  )
}
