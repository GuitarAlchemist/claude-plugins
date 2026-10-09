// Working groups: named sets of sessions, nested by path (`ga`, `ga/chatbot`), kept in one registry
// file every session and agent can read (~/.agents/groups.json). Pure work only: everything that
// reaches the engine (`$`) lives in register.tsx.

export type GroupKind = 'working-group' | 'sub-group' | 'community'
export const KINDS: readonly GroupKind[] = ['working-group', 'sub-group', 'community']

// `members` holds exact session names (`learn-vx`) or patterns with `*` (`learn-*`): a pattern
// survives a restart that changes the name's suffix. `policy: 'pass'` lets messages between two
// members of the group reach the model at once instead of waiting in /inbox.
export type Group = { id: string; kind: GroupKind; title: string; members: string[]; policy: 'hold' | 'pass' }
export type Registry = { version: 1; groups: Group[] }
export type Peer = { name: string; ref: string; state: string }

export const REGISTRY_PATH = '.agents/groups.json' // under the user's home

const ID = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/
const MEMBER = /^[A-Za-z0-9*][A-Za-z0-9*._-]*$/

export function emptyRegistry(): Registry {
  return { version: 1, groups: [] }
}

// A file someone edited by hand may be wrong: say so, and never write over it.
export function parseRegistry(text: string): { registry: Registry; error: string } {
  if (!text.trim()) return { registry: emptyRegistry(), error: '' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { registry: emptyRegistry(), error: `not JSON: ${String(err instanceof Error ? err.message : err).slice(0, 120)}` }
  }
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups) ? (raw as { groups: unknown[] }).groups : undefined
  if (!list) return { registry: emptyRegistry(), error: 'no "groups" array' }
  const groups: Group[] = []
  for (const g of list) {
    if (!g || typeof g !== 'object') continue
    const o = g as Record<string, unknown>
    const id = typeof o['id'] === 'string' ? o['id'].trim().toLowerCase() : ''
    if (!ID.test(id)) continue
    const kind = KINDS.includes(o['kind'] as GroupKind) ? (o['kind'] as GroupKind) : id.includes('/') ? 'sub-group' : 'working-group'
    const members = Array.isArray(o['members']) ? o['members'].filter((m): m is string => typeof m === 'string' && MEMBER.test(m)) : []
    groups.push({
      id,
      kind,
      title: typeof o['title'] === 'string' ? o['title'] : '',
      members,
      policy: o['policy'] === 'pass' ? 'pass' : 'hold',
    })
  }
  return { registry: { version: 1, groups }, error: '' }
}

export function serializeRegistry(registry: Registry): string {
  const groups = [...registry.groups].sort((a, b) => a.id.localeCompare(b.id))
  return `${JSON.stringify({ version: 1, groups }, null, 2)}\n`
}

export function matches(member: string, name: string): boolean {
  if (!member.includes('*')) return member.toLowerCase() === name.toLowerCase()
  const re = new RegExp(`^${member.split('*').map(part => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&')).join('.*')}$`, 'i')
  return re.test(name)
}

export function find(registry: Registry, id: string): Group | undefined {
  return registry.groups.find(g => g.id === id.toLowerCase())
}

// A group's members are its own and its sub-groups': whoever is in ga/chatbot is in ga.
export function isMember(registry: Registry, id: string, name: string): boolean {
  const key = id.toLowerCase()
  return registry.groups.some(g => (g.id === key || g.id.startsWith(`${key}/`)) && g.members.some(m => matches(m, name)))
}

// The groups a session belongs to, with the parents its sub-groups imply, shallowest first.
export function groupsOf(registry: Registry, name: string): string[] {
  return registry.groups
    .filter(g => isMember(registry, g.id, name))
    .map(g => g.id)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

// Why a message may skip the inbox: the group whose policy lets it through, or ''.
export function passingGroup(registry: Registry, sender: string, self: string, broadcast: string): string {
  if (!sender || !self) return ''
  // Both must be members: anyone can write a `[group …]` tag, only the registry makes it count.
  const both = (g: Group) => g.policy === 'pass' && isMember(registry, g.id, sender) && isMember(registry, g.id, self)
  if (broadcast) {
    const g = find(registry, broadcast)
    return g && both(g) ? g.id : ''
  }
  return registry.groups.find(both)?.id ?? ''
}

// What ListAgents answers: "This session is learn-vx [1e4ede] — …" and one row per peer,
// "  demerzel-9a [ac98d9]  ·  interactive  ·  busy  ·  started 1d ago".
export function parseListAgents(text: string): { self: string; peers: Peer[] } {
  const self = /This session is (\S+)/.exec(text)?.[1] ?? ''
  const peers: Peer[] = []
  for (const [, name = '', ref = '', , state = ''] of text.matchAll(/^\s+(\S+) \[([0-9a-f]+)\]\s+·\s+([^·\n]+?)\s+·\s+([^·\n]+?)\s+·/gm)) {
    peers.push({ name, ref, state: state.trim() })
  }
  return { self, peers }
}

// The live members of a group to send to, this session left out; a name two peers share is
// spelled with its ref, as SendMessage asks.
export function recipients(registry: Registry, id: string, peers: readonly Peer[], self: string): { name: string; address: string }[] {
  const chosen = peers.filter(p => p.name !== self && isMember(registry, id, p.name))
  return chosen.map(p => ({
    name: p.name,
    address: peers.filter(q => q.name === p.name).length > 1 ? `${p.name} [${p.ref}]` : p.name,
  }))
}

// A message sent to a group opens with its tag, so a receiver without this mod still reads it.
const TAG = /^\[group ([a-z0-9/-]+)\]\s*/i

export function tagged(id: string, text: string): string {
  return `[group ${id}] ${text.trim()}`
}

export function untag(body: string): { group: string; body: string } {
  const m = TAG.exec(body)
  return m ? { group: (m[1] ?? '').toLowerCase(), body: body.slice(m[0].length) } : { group: '', body }
}

type Change = { registry: Registry; note: string } | { error: string }

export function createGroup(registry: Registry, id: string, kind: string, title: string): Change {
  const key = id.trim().toLowerCase()
  if (!ID.test(key) || key.length > 64) return { error: `"${id}" is not a group id: lowercase letters, digits and -, nested with / (ga/chatbot)` }
  if (find(registry, key)) return { error: `group ${key} already exists` }
  if (kind && !KINDS.includes(kind as GroupKind)) return { error: `kind must be one of ${KINDS.join(', ')}` }
  const k = (kind as GroupKind) || (key.includes('/') ? 'sub-group' : 'working-group')
  const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const note = parent && !find(registry, parent) ? ` (its parent ${parent} does not exist yet)` : ''
  return { registry: { version: 1, groups: [...registry.groups, { id: key, kind: k, title: title.trim(), members: [], policy: 'hold' }] }, note: `Created ${k} ${key}${note}` }
}

function edit(registry: Registry, id: string, change: (g: Group) => Group | string): Change {
  const g = find(registry, id)
  if (!g) return { error: `no group ${id.toLowerCase()} (/inbox groups lists them)` }
  const next = change(g)
  if (typeof next === 'string') return { error: next }
  return { registry: { version: 1, groups: registry.groups.map(x => (x.id === g.id ? next : x)) }, note: '' }
}

export function addMember(registry: Registry, id: string, member: string): Change {
  if (!MEMBER.test(member)) return { error: `"${member}" is not a session name or pattern (letters, digits, . _ - and *)` }
  const r = edit(registry, id, g => (g.members.some(m => m.toLowerCase() === member.toLowerCase()) ? `${member} is already in ${g.id}` : { ...g, members: [...g.members, member] }))
  return 'error' in r ? r : { ...r, note: `${member} joined ${id.toLowerCase()}` }
}

export function removeMember(registry: Registry, id: string, member: string): Change {
  const r = edit(registry, id, g => {
    const kept = g.members.filter(m => m.toLowerCase() !== member.toLowerCase())
    if (kept.length === g.members.length) {
      const via = g.members.filter(m => m.includes('*') && matches(m, member))
      return via.length ? `${member} is in ${g.id} through ${via.join(', ')}: leave with that pattern` : `${member} is not listed in ${g.id}`
    }
    return { ...g, members: kept }
  })
  return 'error' in r ? r : { ...r, note: `${member} left ${id.toLowerCase()}` }
}

export function setPolicy(registry: Registry, id: string, policy: string): Change {
  if (policy !== 'pass' && policy !== 'hold') return { error: 'policy is pass or hold' }
  const r = edit(registry, id, g => ({ ...g, policy }))
  return 'error' in r ? r : { ...r, note: `${id.toLowerCase()}: messages between its members now ${policy === 'pass' ? 'pass straight through' : 'wait in /inbox'}` }
}

const KIND_LABEL: Record<GroupKind, string> = { 'working-group': 'working group', 'sub-group': 'sub-group', community: 'community of practice' }

export function describe(registry: Registry, peers: readonly Peer[], self: string): string {
  if (registry.groups.length === 0) return 'No groups yet. Create one with /inbox group create <id> [working-group|sub-group|community] [title].'
  const lines: string[] = []
  for (const g of [...registry.groups].sort((a, b) => a.id.localeCompare(b.id))) {
    const depth = g.id.split('/').length - 1
    const pad = '  '.repeat(depth)
    const live = peers.filter(p => isMember(registry, g.id, p.name)).map(p => p.name)
    const you = self && isMember(registry, g.id, self) ? ' · you are in it' : ''
    lines.push(`${pad}${g.id} (${KIND_LABEL[g.kind]}, ${g.policy})${g.title ? ` — ${g.title}` : ''}${you}`)
    lines.push(`${pad}  members: ${g.members.join(', ') || 'none'} · live now: ${live.join(', ') || 'none'}`)
  }
  return lines.join('\n')
}

// What the user typed after /inbox.
export type Command =
  | { kind: 'open' }
  | { kind: 'mode'; mode: 'hold' | 'pass' }
  | { kind: 'groups' }
  | { kind: 'send'; group: string; text: string }
  | { kind: 'create'; group: string; groupKind: string; title: string }
  | { kind: 'join' | 'leave'; group: string; member: string }
  | { kind: 'policy'; group: string; policy: string }
  | { kind: 'usage' }

export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [first = '', second = '', third = '', fourth = ''] = words
  const rest = (n: number) => words.slice(n).join(' ')
  switch (first.toLowerCase()) {
    case '':
      return { kind: 'open' }
    case 'hold':
    case 'pass':
      return { kind: 'mode', mode: first.toLowerCase() as 'hold' | 'pass' }
    case 'groups':
      return { kind: 'groups' }
    case 'send':
      return second && words.length > 2 ? { kind: 'send', group: second.toLowerCase(), text: args.trim().replace(/^send\s+\S+\s+/i, '') } : { kind: 'usage' }
    case 'group': {
      const verb = second.toLowerCase()
      if (verb === 'create' && third) {
        const isKind = KINDS.includes(fourth as GroupKind)
        return { kind: 'create', group: third, groupKind: isKind ? fourth : '', title: rest(isKind ? 4 : 3) }
      }
      if ((verb === 'join' || verb === 'leave') && third) return { kind: verb, group: third, member: fourth }
      if (verb === 'policy' && third && fourth) return { kind: 'policy', group: third, policy: fourth.toLowerCase() }
      return { kind: 'usage' }
    }
    default:
      return { kind: 'usage' }
  }
}

export const USAGE = [
  '/inbox                         open the pane',
  '/inbox hold | pass             hold messages here, or let them all through',
  '/inbox groups                  list the working groups and who is live in each',
  '/inbox send <group> <text>     send one message to every live member of a group',
  '/inbox group create <id> [working-group|sub-group|community] [title]',
  '/inbox group join <id> [member]     add this session, or a name or pattern (learn-*)',
  '/inbox group leave <id> [member]',
  '/inbox group policy <id> pass|hold  let messages between its members skip the inbox',
  `Groups live in ~/${REGISTRY_PATH}; edit it by hand if you like.`,
].join('\n')

// The model's own group posts: at most this many in this window, so two agents cannot keep a group busy.
export const MODEL_SENDS = { max: 3, windowMs: 10 * 60_000 }

export function canModelSend(sentAt: readonly number[], now: number): { ok: boolean; recent: number[] } {
  const recent = sentAt.filter(t => now - t < MODEL_SENDS.windowMs)
  return { ok: recent.length < MODEL_SENDS.max, recent }
}

// Delivery failures and the hand-over to the model.

export type Failure = { name: string; reason: string }

// Identical reasons told once: "learn-17, ga-c0: reason; music-7c: another".
export function failures(list: readonly Failure[]): string {
  const by = new Map<string, string[]>()
  for (const f of list) by.set(f.reason, [...(by.get(f.reason) ?? []), f.name])
  return [...by].map(([reason, names]) => `${names.join(', ')}: ${reason}`).join('; ')
}

// The permission layer refused the plugin's send, not the recipient: in auto mode the classifier
// gives no verdict on a send no model turn asked for. Trying the other members would fail alike.
export const REFUSED_BY_PERMISSIONS = /classifier|permission|approv|not allowed|denied/i

// What the model reads when the plugin could not send: the recipients and the exact text, for its
// own SendMessage calls, which the permission layer judges with the turn's context.
export function handOver(group: string, addresses: readonly string[], message: string, reason: string, by: 'user' | 'model'): string {
  const head =
    by === 'user'
      ? `The user posted to group ${group} with /inbox, and the plugin could not send it: this session's permission mode refused the plugin's own send (${reason}).`
      : `Not sent by the plugin: this session's permission mode refused its own send (${reason}).`
  return [
    head,
    `Send it ${by === 'user' ? '' : 'yourself '}with SendMessage, one call per recipient (${addresses.join(', ')}), with exactly this message, then stop:`,
    '',
    message,
  ].join('\n')
}
