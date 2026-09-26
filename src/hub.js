/**
 * The Agent Hub core: one board per parent session, one card per real child
 * agent, and one feed both the humans and the agents read.
 *
 * Everything here is transport-independent. `src/http.js` exposes it as a
 * same-origin route plus an SSE stream, `src/tools.js` exposes it to the agents
 * themselves, and `src/observe.js` feeds it the session and subagent events.
 *
 * Two rules shape the design:
 *
 * 1. **The board is a projection, not a second source of truth.** A card's
 *    status and output are derived from the events the harness already emits
 *    for the child's own session. Nothing here invents progress, so a card can
 *    never claim work the agent did not do. `subagent/end` is the only place a
 *    terminal status comes from.
 * 2. **Children are continuable, not one-shot.** A one-shot child runs once and
 *    its answer is final; a continuable child keeps a durable identity and an
 *    inbox, which is what lets the board steer it later, wake it after it went
 *    idle, and deliver a peer's message to it. That is the whole point of the
 *    feature, so `startContinuable` is the only start path used here.
 *
 * @module dsh-agent-hub/src/hub
 */

import { randomUUID } from 'node:crypto'

import { draftPlan } from './llm.js'
import { buildAgentPrompt, buildAgentPersona } from './prompt.js'
import { publishPlan, readTeam, settleTask } from './team.js'

/** Statuses from which an agent does not move on its own any more. */
const TERMINAL_STATUSES = new Set(['done', 'error', 'stopped'])

/**
 * Keep only well-formed `provider/model` strings from a caller-supplied list.
 *
 * A malformed entry is dropped rather than rejected: the list is a preference
 * about how to spread work, and refusing the whole launch because one entry had a
 * trailing slash would make the flexible path the fragile one.
 * @param {unknown} value - Candidate list.
 * @returns {string[]} Valid routes, capped.
 */
function routeStringsOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(entry => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.indexOf('/') > 0 && entry.indexOf('/') < entry.length - 1)
    .slice(0, 24)
}

/** Statuses that mean "launched and still part of the run". */
const LIVE_STATUSES = new Set(['queued', 'running', 'idle'])

/**
 * Candidate tool names per power. Names are probed against the live registry
 * before they are ever put into a `tools.restrict()` filter, because naming an
 * unregistered tool there throws.
 */
const SHELL_TOOLS = ['pwsh', 'bash', 'shell', 'run_code', 'bash_session']
const WRITE_TOOLS = ['write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit']
/** The read-only whitelist: analysis, research, and the hub's own channels. */
const READ_ONLY_TOOLS = [
  'read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write',
  'hub_post', 'hub_read', 'job_list', 'job_output', 'skill',
]

/** Feed entries auto-generated for tool calls, throttled per agent. */
const TOOL_FEED_INTERVAL_MS = 1500
/** Coalescing window for `agent` frames, in milliseconds. */
const FRAME_COALESCE_MS = 150

/** A request-level failure the HTTP layer turns into a status + message. */
export class HubError extends Error {
  /**
   * @param {number} status - HTTP status the route should answer with.
   * @param {string} message - Human-readable reason shown to the UI as-is.
   */
  constructor(status, message) {
    super(message)
    this.name = 'HubError'
    this.status = status
  }
}

/**
 * Join the text blocks of a content array.
 * @param {unknown} content - Message content (array of blocks, or a string).
 * @returns {string} Concatenated text, empty when there is none.
 */
export function textFromBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Collapse a value to one tidy line for an activity label.
 * @param {unknown} value - Raw value.
 * @param {number} limit - Maximum length.
 * @returns {string} Single-line, length-capped text.
 */
function oneLine(value, limit) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * Keep the tail of a growing text.
 * @param {string} existing - Text retained so far.
 * @param {string} addition - Text to append.
 * @param {number} limit - Maximum retained characters.
 * @returns {string} The tail.
 */
function tail(existing, addition, limit) {
  const joined = existing === '' ? addition : `${existing}\n${addition}`
  return joined.length <= limit ? joined : joined.slice(joined.length - limit)
}

/**
 * Keep the tail of a token stream.
 *
 * Stream deltas are fragments of one sentence, so the newline `tail` inserts
 * between turns would corrupt every word boundary in the live view.
 * @param {string} existing - Text accumulated so far.
 * @param {string} addition - Delta to append.
 * @param {number} limit - Maximum retained characters.
 * @returns {string} The tail.
 */
function streamTail(existing, addition, limit) {
  const joined = `${existing}${addition}`
  return joined.length <= limit ? joined : joined.slice(joined.length - limit)
}

/** One collaboration board, keyed by the parent session id. */
export class Hub {
  /** @type {Map<string, Record<string, any>>} */
  #boards = new Map()
  /** @type {Map<string, Set<(event: string, data: unknown) => void>>} */
  #subscribers = new Map()
  /** Child session id -> owning board + the card it belongs to. */
  #children = new Map()
  /** sessionId -> clientIds awaiting a coalesced `agent` frame. */
  #dirty = new Map()
  /** sessionId -> coalescing timer. */
  #timers = new Map()
  /** Last route list read from the catalogue, for synchronously built prompts. */
  #routes = []

  /**
   * @param {{ ctx: Record<string, any>, settings: Record<string, any> }} options - Plugin context and normalized config.
   */
  constructor({ ctx, settings }) {
    this.ctx = ctx
    this.settings = settings
  }

  /**
   * The conversation a session's board belongs to.
   *
   * A board belongs to a conversation, never to one of its subagents, so a
   * subagent session resolves upward to the root it descends from. Without this, a
   * subagent that touched any operation keyed by its own id would allocate a
   * **second** board, and `hub_read` would then resolve to that empty board
   * instead of the team it is working with: the roster would silently fragment and
   * the one guarantee this feature makes — you see the board you are on, and only
   * that one — would stop being true.
   *
   * The walk is bounded because a malformed lineage must not become an infinite
   * loop in a function called on every frame.
   * @param {string} sessionId - Any session id, root or subagent.
   * @returns {string} The owning conversation's id.
   */
  #boardSessionOf(sessionId) {
    let current = sessionId
    for (let depth = 0; depth < 8; depth += 1) {
      const agent = this.ctx.get?.('agents')?.get?.(current)
      const parent = agent?.session?.header?.parentSession
      if (typeof parent !== 'string' || parent === '') return current
      current = parent
    }
    return current
  }

  /**
   * Refuse to let a subagent own a board of its own.
   *
   * Ownership is the three verbs that *create or destroy* a board. Reads and
   * deliveries resolve to the conversation's board instead, so a subagent works
   * with its teammates; a launch would instead replace the roster its teammates
   * live in.
   * @param {string} sessionId - Session attempting the operation.
   * @returns {void}
   * @throws {HubError} 409 when the caller is a subagent.
   */
  #assertBoardOwner(sessionId) {
    if (this.#boardSessionOf(sessionId) === sessionId) return
    throw new HubError(
      409,
      '子智能体不能自己开台或清台：你已经是某个会话的子智能体，只能与你所属会话那块台上的同伴协作。'
      + '要看同伴的进度用 hub_read，要汇报用 hub_post。',
    )
  }

  /**
   * Board backing one session, created empty on first use.
   * @param {string} sessionId - Parent session id, or any of its subagents.
   * @returns {Record<string, any>} The board.
   */
  board(sessionId) {
    const key = this.#boardSessionOf(sessionId)
    let board = this.#boards.get(key)
    if (board === undefined) {
      board = {
        sessionId: key,
        objective: '',
        agents: [],
        feed: [],
        feedSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.#boards.set(key, board)
    }
    return board
  }

  /**
   * The board of one session, **without creating one**.
   *
   * `board()` allocates on demand, which is right for a request that is about to
   * write. A prompt section asking "is there a board here" runs on every request
   * of every session, so it must not be able to allocate one.
   * @param {string} sessionId - Parent session id, or any of its subagents.
   * @returns {Record<string, any>|undefined} The board, when the session has one.
   */
  peek(sessionId) {
    return this.#boards.get(this.#boardSessionOf(sessionId))
  }

  /**
   * Public snapshot of one board, exactly the shape `CONTRACT.md` documents.
   * @param {string} sessionId - Parent session id.
   * @returns {Record<string, any>} The state payload.
   */
  state(sessionId) {
    const board = this.board(sessionId)
    // The team is read for the *conversation*, not for whichever session asked:
    // a subagent's team identity is its own by construction (`tryMembership`
    // returns undefined for a subagent), so reading it for the child id would
    // report an empty team beside a full board.
    const team = readTeam(this.ctx, this.ctx.get?.('agents')?.get?.(board.sessionId))
    if (board.teamWarning !== undefined && board.teamWarning !== null) team.warning = board.teamWarning
    return {
      // The resolved owner, so a caller that passed a subagent id learns which
      // conversation's board it actually got instead of seeing an echo.
      sessionId: board.sessionId,
      objective: board.objective,
      phase: phaseOf(board),
      agents: board.agents.map(card => ({ ...card })),
      feed: board.feed.map(item => ({ ...item })),
      // The durable half of the integration: the harness's own Agent Teams state,
      // read rather than mirrored, so one board can show both rosters.
      team,
      providers: this.providers(),
      hasLLM: typeof this.ctx.get?.('llm')?.stream === 'function',
      limits: { maxAgents: this.settings.maxAgents },
      now: Date.now(),
    }
  }

  /**
   * Feed items after one id, oldest first.
   * @param {string} sessionId - Parent session id.
   * @param {{ since?: string, limit?: number }} [options] - Cursor and page size.
   * @returns {{ items: Record<string, any>[], lastId: string|null }} The page.
   */
  feed(sessionId, options = {}) {
    const board = this.board(sessionId)
    const since = options.since
    let items = board.feed
    if (typeof since === 'string' && since !== '') {
      // The cursor is the id of the last item the caller already has; a cursor
      // that has been trimmed out of the ring returns everything retained
      // rather than silently nothing.
      const index = board.feed.findIndex(item => item.id === since)
      items = index < 0 ? board.feed : board.feed.slice(index + 1)
    }
    const limit = typeof options.limit === 'number' ? Math.min(Math.max(options.limit, 1), 500) : 200
    const page = items.slice(-limit)
    return { items: page.map(item => ({ ...item })), lastId: board.feed.at(-1)?.id ?? null }
  }

  /**
   * Names of the session event types this hub reacts to; exported for the UI's
   * "what counts as progress" legend and for tests.
   * @returns {string[]} Event type names.
   */
  observedEventTypes() {
    return ['turn/start', 'turn/end', 'step/start', 'tool/call', 'assistant/message', 'subagent/start', 'subagent/end']
  }

  /** @returns {string[]} Subagent provider names the runtime reports. */
  providers() {
    const subagents = this.ctx.get?.('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.list !== 'function') return []
    try {
      return subagents.list()
    } catch {
      return []
    }
  }

  /**
   * Subscribe to one board's frames.
   * @param {string} sessionId - Parent session id.
   * @param {(event: string, data: unknown) => void} send - Frame sink; must not throw.
   * @returns {() => void} Unsubscribe.
   */
  subscribe(sessionId, send) {
    // Resolved like every other entry point: a subscriber keyed by a subagent id
    // would never match the frames emitted under the conversation's id.
    const key = this.#boardSessionOf(sessionId)
    let set = this.#subscribers.get(key)
    if (set === undefined) {
      set = new Set()
      this.#subscribers.set(key, set)
    }
    set.add(send)
    return () => {
      set.delete(send)
      if (set.size === 0) this.#subscribers.delete(key)
    }
  }

  /**
   * Provider/model catalog the UI offers per agent.
   * @returns {Promise<{ providers: Record<string, any>[], hasLLM: boolean }>} The catalog.
   */
  async catalog() {
    const llm = this.ctx.get?.('llm')
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
      return { providers: [], hasLLM: false }
    }
    const providers = []
    const routes = []
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = (await llm.listModels(provider.id)).map(model => ({
          id: model.id,
          name: model.name ?? model.id,
        }))
      } catch {
        // One unreachable provider must not empty the whole picker; the UI
        // shows it with an empty model list instead.
        models = []
      }
      providers.push({ provider: provider.id, name: provider.name ?? provider.id, models })
      for (const model of models) routes.push(`${provider.id}/${model.id}`)
    }
    // Kept so the policy section can name the real options: a prompt assembled on
    // every request cannot afford to await the catalogue, and an agent that does
    // not know the routes cannot choose between providers.
    this.#routes = routes
    return { providers, hasLLM: true }
  }

  /**
   * The cached route list, refreshed by {@link catalog}.
   * @returns {string[]} `provider/model` strings, empty until the first refresh.
   */
  routesSync() {
    return this.#routes
  }

  /**
   * Ask the coordinator model to split one objective into agent rows.
   * @param {string} sessionId - Parent session id.
   * @param {{ objective: string, count?: number, coordinator?: Record<string, any>, signal?: AbortSignal }} request - Split request.
   * @returns {Promise<Record<string, any>>} The draft plus call metadata.
   */
  async draft(sessionId, request) {
    this.#assertBoardOwner(sessionId)
    const board = this.board(sessionId)
    const objective = String(request.objective ?? '').trim()
    if (objective === '') throw new HubError(400, 'objective 不能为空')
    const count = clampCount(request.count, this.settings.maxAgents)
    const route = await this.#resolveRoute(sessionId, request.coordinator)
    let result
    try {
      result = await draftPlan({
        ctx: this.ctx,
        route,
        objective,
        count,
        sessionId,
        maxTokens: this.settings.coordinatorMaxTokens,
        timeoutMs: this.settings.coordinatorTimeoutMs,
        signal: request.signal,
        defaults: { write: this.settings.defaultWrite, shell: this.settings.defaultShell },
        // The caller's route shortlist, used only where the coordinator named
        // none: explicit variety rather than every agent inheriting one model.
        spread: routeStringsOf(request.models),
      })
    } catch (error) {
      // A model or transport failure is an upstream problem, not the caller's:
      // 502 tells the UI to offer "retry / fill the rows in by hand".
      if (error instanceof HubError) throw error
      throw new HubError(502, messageOf(error))
    }
    board.objective = objective
    this.#replaceAgents(board, result.agents.map((agent, index) => createCard(agent, index, this.settings)))
    board.updatedAt = Date.now()
    this.append(board.sessionId, {
      kind: 'plan',
      from: 'system',
      fromName: '系统',
      text: `协调者（${route.provider}/${route.model}）把目标拆成 ${board.agents.length} 个角色：${board.agents.map(a => a.name).join('、')}`,
    })
    this.#emitBoard(board)
    return { draft: { objective, agents: board.agents.map(card => ({ ...card })) }, usage: result.usage }
  }

  /**
   * Start every agent of the current draft.
   *
   * Cards are created before the first `startContinuable` call so the UI shows
   * all of them immediately, and each failure is recorded on its own card: one
   * provider refusal must not cancel the sibling agents that are already fine.
   * @param {string} sessionId - Parent session id.
   * @param {{ objective?: string, agents: Record<string, any>[], signal?: AbortSignal }} payload - Launch request.
   * @param {{ parent?: Record<string, any> }} [options] - Caller-held live parent Agent, when the caller already has one.
   * @returns {Promise<Record<string, any>>} The started cards.
   */
  async launch(sessionId, payload, options = {}) {
    this.#assertBoardOwner(sessionId)
    const subagents = this.ctx.get?.('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.startContinuable !== 'function') {
      throw new HubError(503, '子智能体服务不可用：这个部署没有加载 subagent 运行时')
    }
    const specs = Array.isArray(payload.agents) ? payload.agents : []
    if (specs.length === 0) throw new HubError(400, 'agents 至少要有一个')
    if (specs.length > this.settings.maxAgents) {
      throw new HubError(400, `agents 最多 ${this.settings.maxAgents} 个，收到 ${specs.length} 个`)
    }
    // Fill rows that named no model from the caller's shortlist, before
    // validation: "spread these three roles across these two providers" is the
    // whole point of passing a list, and requiring each row to repeat one would
    // make the roster path as rigid as it was before.
    const spread = routeStringsOf(payload.models)
    if (spread.length > 0) {
      let next = 0
      for (const spec of specs) {
        if (spec === null || typeof spec !== 'object') continue
        const chosen = typeof spec.model?.provider === 'string' && spec.model.provider !== ''
          && typeof spec.model?.model === 'string' && spec.model.model !== ''
        if (chosen) continue
        const picked = routeStringsOf([spread[next % spread.length]])[0]
        next += 1
        if (picked === undefined) continue
        const cut = picked.indexOf('/')
        spec.model = { ...(spec.model ?? {}), provider: picked.slice(0, cut), model: picked.slice(cut + 1) }
      }
    }
    for (const [index, spec] of specs.entries()) validateSpec(spec, index)

    // A tool caller already holds its own live Agent (`exec.agent`), which is a
    // stronger credential than a lookup by session id: it is the exact agent
    // making the call, so nothing can race and nothing can come back empty.
    const parent = options.parent ?? this.#liveParent(sessionId)
    const provider = this.#pickProvider()
    const board = this.board(sessionId)
    if (typeof payload.objective === 'string' && payload.objective.trim() !== '') {
      board.objective = payload.objective.trim()
    }

    // A fresh launch replaces the previous roster: keeping stale terminal cards
    // around would make "phase" lie about what is actually running. The child
    // index is purged with them, or a replaced agent's later events would
    // resolve to whichever new card happens to reuse its local id.
    this.#replaceAgents(board, specs.map((spec, index) => createCard(spec, index, this.settings)))
    const roster = board.agents.map(card => ({ name: card.name, role: card.role, files: card.files }))

    const results = await Promise.allSettled(board.agents.map(async (card) => {
      const start = await subagents.startContinuable({
        provider,
        label: `${card.name}${card.role === '' ? '' : ` · ${card.role}`}`.slice(0, 120),
        signal: payload.signal ?? new AbortController().signal,
        request: {
          parent,
          prompt: [{ type: 'text', text: buildAgentPrompt(card, board.objective, roster) }],
          ...(agentOptionsOf(card) === undefined ? {} : { agentOptions: agentOptionsOf(card) }),
          persona: buildAgentPersona(card),
          ...(this.#toolFilter(card.powers) === undefined ? {} : { toolFilter: this.#toolFilter(card.powers) }),
        },
      })
      return { card, start }
    }))

    for (const [index, result] of results.entries()) {
      const card = board.agents[index]
      if (result.status === 'fulfilled') {
        card.id = result.value.start.childId
        card.status = 'running'
        card.startedAt = Date.now()
        card.lastActivityAt = Date.now()
        card.activity = '已派发，等待第一步'
        this.#children.set(card.id, { sessionId, clientId: card.clientId })
        this.append(board.sessionId, {
          kind: 'system',
          from: 'system',
          fromName: '系统',
          agentId: card.id,
          text: `${card.name} 已启动（${card.model.provider}/${card.model.model}${card.powers.write ? '，可写' : '，只读'}）`,
        })
      } else {
        card.status = 'error'
        card.endedAt = Date.now()
        card.error = messageOf(result.reason)
        this.append(board.sessionId, {
          kind: 'system',
          from: 'system',
          fromName: '系统',
          agentId: card.id,
          text: `${card.name} 启动失败：${card.error}`,
        })
      }
      this.#emitAgent(sessionId, card)
    }
    this.#emitBoard(board)
    // The durable half of the integration: the roster the user just approved is
    // published as real team tasks, so the native Team UI and the `team_task_*`
    // tools see the same plan. Best-effort — the agents are already running, so a
    // board that refuses one row must not cancel the launch.
    const plan = await publishPlan(this.ctx, parent, board.agents)
    if (plan.published > 0) {
      this.append(board.sessionId, {
        kind: 'plan',
        from: 'system',
        fromName: '系统',
        text: `已把这 ${plan.published} 项工作写进原生团队任务板（团队面板与 team_task_list 都能看到）`,
      })
    }
    if (plan.error !== null) this.#noteTeamWarning(board, `原生任务板写入失败：${plan.error}`)
    return { agents: board.agents.map(card => ({ ...card })) }
  }

  /**
   * Deliver a human message to one agent.
   * @param {string} sessionId - Parent session id.
   * @param {{ agentId: string, text: string, delivery?: string, signal?: AbortSignal }} request - Steer request.
   * @returns {Promise<Record<string, any>>} Acceptance receipt.
   */
  async steer(sessionId, request) {
    const board = this.board(sessionId)
    const card = findCard(board, request.agentId)
    const text = String(request.text ?? '').trim()
    if (text === '') throw new HubError(400, 'text 不能为空')
    if (card.id === null) throw new HubError(409, '这个智能体还没有启动，先启动再插话')
    const delivery = request.delivery === 'steer' ? 'steer' : 'queue'
    const messageId = await this.#deliver(sessionId, card, text, delivery, 'human', '你', request.signal)
    this.append(board.sessionId, {
      kind: 'human',
      from: 'human',
      fromName: '你',
      to: card.id,
      toName: card.name,
      agentId: card.id,
      text: `${delivery === 'steer' ? '插话' : '留言'}：${text}`,
    })
    return { accepted: true, messageId }
  }

  /**
   * Deliver a human message to several agents (or all of them).
   * @param {string} sessionId - Parent session id.
   * @param {{ text: string, to?: string[]|null, signal?: AbortSignal }} request - Broadcast request.
   * @returns {Promise<Record<string, any>>} Delivery count.
   */
  async broadcast(sessionId, request) {
    const board = this.board(sessionId)
    const text = String(request.text ?? '').trim()
    if (text === '') throw new HubError(400, 'text 不能为空')
    const targets = Array.isArray(request.to) && request.to.length > 0
      ? board.agents.filter(card => request.to.includes(card.id) || request.to.includes(card.clientId))
      : board.agents
    const live = targets.filter(card => card.id !== null)
    if (live.length === 0) throw new HubError(409, '没有已启动的智能体可以接收广播')
    const results = await Promise.allSettled(live.map(card => (
      this.#deliver(sessionId, card, text, 'queue', 'human', '你', request.signal)
    )))
    this.append(board.sessionId, {
      kind: 'human',
      from: 'human',
      fromName: '你',
      to: '*',
      toName: '全体',
      text: `广播：${text}`,
    })
    return { accepted: true, delivered: results.filter(result => result.status === 'fulfilled').length }
  }

  /**
   * Wake an idle agent with a short nudge, or with the caller's text.
   * @param {string} sessionId - Parent session id.
   * @param {{ agentId: string, text?: string, signal?: AbortSignal }} request - Wake request.
   * @returns {Promise<Record<string, any>>} Acceptance receipt.
   */
  async wake(sessionId, request) {
    const board = this.board(sessionId)
    const card = findCard(board, request.agentId)
    if (card.id === null) throw new HubError(409, '这个智能体还没有启动')
    const text = String(request.text ?? '').trim()
    const messageId = await this.#deliver(
      sessionId,
      card,
      text === '' ? `请继续：${board.objective === '' ? '推进你的子任务' : board.objective}` : text,
      'queue',
      'human',
      '你',
      request.signal,
    )
    this.append(board.sessionId, {
      kind: 'human',
      from: 'human',
      fromName: '你',
      to: card.id,
      toName: card.name,
      agentId: card.id,
      text: text === '' ? '唤醒了它，让它继续推进' : `唤醒并交代：${text}`,
    })
    return { accepted: true, messageId }
  }

  /**
   * Interrupt one agent's live turn without ending its run.
   * @param {string} sessionId - Parent session id.
   * @param {{ agentId: string }} request - Interrupt request.
   * @returns {Record<string, any>} Acceptance receipt.
   */
  interrupt(sessionId, request) {
    const board = this.board(sessionId)
    const card = findCard(board, request.agentId)
    if (card.id === null) throw new HubError(409, '这个智能体还没有启动')
    const subagents = this.ctx.get?.('subagents')
    if (subagents === undefined || typeof subagents.interrupt !== 'function') {
      throw new HubError(503, '子智能体服务不可用')
    }
    subagents.interrupt(card.id, { kind: 'user', parentSessionId: sessionId })
    card.activity = '已被打断'
    this.append(board.sessionId, {
      kind: 'system',
      from: 'system',
      fromName: '系统',
      agentId: card.id,
      text: `打断了 ${card.name} 当前这一轮`,
    })
    this.#emitAgent(sessionId, card)
    return { accepted: true }
  }

  /**
   * Interrupt every agent that is still live.
   * @param {string} sessionId - Parent session id.
   * @returns {Record<string, any>} How many were interrupted.
   */
  stopAll(sessionId) {
    const board = this.board(sessionId)
    let stopped = 0
    const subagents = this.ctx.get?.('subagents')
    for (const card of board.agents) {
      if (card.id === null || !LIVE_STATUSES.has(card.status)) continue
      try {
        subagents?.interrupt?.(card.id, { kind: 'user', parentSessionId: sessionId })
        card.activity = '已停止'
        stopped += 1
        this.#emitAgent(sessionId, card)
      } catch (error) {
        card.error = messageOf(error)
      }
    }
    if (stopped > 0) {
      this.append(board.sessionId, {
        kind: 'system',
        from: 'system',
        fromName: '系统',
        text: `停止了 ${stopped} 个仍在运行的智能体`,
      })
    }
    return { accepted: true, stopped }
  }

  /**
   * Drop one board. The children keep existing as sessions; this only forgets
   * the board, which is why the UI calls it "新建一块台" rather than "停止".
   * @param {string} sessionId - Parent session id.
   * @returns {Record<string, any>} Acceptance receipt.
   */
  clear(sessionId) {
    this.#assertBoardOwner(sessionId)
    const board = this.#boards.get(sessionId)
    if (board !== undefined) {
      for (const card of board.agents) if (card.id !== null) this.#children.delete(card.id)
      this.#boards.delete(sessionId)
      const timer = this.#timers.get(sessionId)
      if (timer !== undefined) clearTimeout(timer)
      this.#timers.delete(sessionId)
      this.#dirty.delete(sessionId)
      this.#emit(sessionId, 'board', { sessionId, objective: '', phase: 'idle', cleared: true })
    }
    return { accepted: true }
  }

  /**
   * Append one feed item from an agent (or from the host on its behalf).
   * @param {string} boardSessionId - Parent session id owning the board.
   * @param {{ from: string, fromName: string, to?: string|null, toName?: string|null, agentId?: string|null, kind?: string, text: string }} input - Feed entry.
   * @returns {Record<string, any>} The stored item.
   */
  append(boardSessionId, input) {
    const board = this.board(boardSessionId)
    board.feedSeq += 1
    const item = {
      id: `f${board.feedSeq}`,
      time: Date.now(),
      kind: typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'progress',
      from: input.from,
      fromName: input.fromName,
      to: input.to ?? null,
      toName: input.toName ?? null,
      agentId: input.agentId ?? null,
      text: String(input.text ?? ''),
    }
    board.feed.push(item)
    board.updatedAt = item.time
    const overflow = board.feed.length - this.settings.feedLimit
    if (overflow > 0) board.feed.splice(0, overflow)
    this.#emit(boardSessionId, 'feed', item)
    return item
  }

  /**
   * Publish one progress note from a child agent, optionally handing it to a peer.
   * @param {string} senderSessionId - Session id of the calling agent.
   * @param {{ to?: string, kind?: string, text: string }} input - Post content.
   * @returns {Promise<Record<string, any>>} What was recorded and delivered.
   */
  async postFromAgent(senderSessionId, input) {
    const text = String(input.text ?? '').trim()
    if (text === '') throw new HubError(400, 'text 不能为空')
    const located = this.#locate(senderSessionId)
    if (located === null) {
      throw new HubError(409, '调用方不在任何协作台上：只有协作台派发的智能体（或它所在的父会话）能在进度板上发言')
    }
    const { board, card } = located
    const speaker = this.#speakerName(board, senderSessionId, card)
    const target = typeof input.to === 'string' ? input.to.trim() : ''
    if (target === '' || target === 'all' || target === '*') {
      const item = this.append(board.sessionId, {
        kind: input.kind ?? 'progress',
        from: senderSessionId,
        fromName: speaker,
        to: '*',
        toName: '全体',
        agentId: senderSessionId,
        text,
      })
      return { item, delivered: 0 }
    }
    const peer = findPeer(board, target)
    if (peer.id === null) throw new HubError(409, `同伴 ${peer.name} 还没有启动`)
    if (peer.id === senderSessionId) throw new HubError(400, '不能给自己发消息')
    const messageId = await this.#deliver(
      board.sessionId, peer, `来自同伴 ${speaker} 的进度：${text}`, 'queue', 'agent', speaker,
    )
    const item = this.append(board.sessionId, {
      kind: 'handoff',
      from: senderSessionId,
      fromName: speaker,
      to: peer.id,
      toName: peer.name,
      agentId: senderSessionId,
      text,
    })
    return { item, delivered: 1, messageId }
  }

  /**
   * Read the board as one of its agents.
   * @param {string} senderSessionId - Session id of the calling agent.
   * @param {{ limit?: number, since?: string }} [options] - Page options.
   * @returns {Record<string, any>} A compact view for a model to read.
   */
  readFor(senderSessionId, options = {}) {
    const located = this.#locate(senderSessionId)
    if (located === null) throw new HubError(409, '调用方不在任何协作台上')
    const { board, card } = located
    const limit = typeof options.limit === 'number' ? Math.min(Math.max(options.limit, 1), 100) : 25
    // The published schema declares `since` as a number (epoch milliseconds);
    // accept the string form too so older callers keep filtering.
    const since = typeof options.since === 'number' || typeof options.since === 'string' ? String(options.since) : ''
    const items = board.feed
      .filter(item => since === '' || item.time >= Number(since))
      .slice(-limit)
    return {
      objective: board.objective,
      you: card === null
        ? { name: this.#speakerName(board, senderSessionId, card), task: board.objective }
        : { name: card.name, task: card.task, files: card.files },
      roster: board.agents.map(agent => ({
        name: agent.name,
        role: agent.role,
        status: agent.status,
        files: agent.files,
        id: agent.id,
      })),
      feed: items.map(item => ({
        time: item.time,
        from: item.fromName,
        to: item.toName ?? '—',
        kind: item.kind,
        text: oneLine(item.text, 400),
      })),
      // The harness's own Agent Teams state, so an agent reading the board sees
      // one picture: its peers on this board *and* the team the harness knows
      // about, with the durable task board both of them write to.
      team: readTeam(this.ctx, this.ctx.get?.('agents')?.get?.(board.sessionId)),
    }
  }

  /**
   * Fold one committed session event into a card.
   * @param {Record<string, any>} session - Session the event belongs to.
   * @param {Record<string, any>} event - Committed session event.
   * @returns {void}
   */
  noteSessionEvent(session, event) {
    const located = this.#locate(session?.id)
    if (located === null || located.card === null) return
    const { board, card } = located
    const data = event?.data ?? {}
    const now = Date.now()
    card.lastActivityAt = now
    switch (event?.type) {
      case 'turn/start':
        card.status = 'running'
        card.startedAt ??= now
        card.activity = `第 ${data.turn ?? '?'} 轮开始`
        this.#emitAgent(board.sessionId, card)
        return
      case 'step/start':
        card.status = 'running'
        card.activity = `第 ${data.turn ?? '?'} 轮 · 第 ${data.step ?? '?'} 步`
        this.#emitAgent(board.sessionId, card)
        return
      case 'tool/call': {
        const detail = toolDetail(data.name, data.arguments)
        card.activity = detail === '' ? `调用 ${data.name}` : `${detail}`
        card.toolCalls = (card.toolCalls ?? 0) + 1
        // Tool calls are the highest-frequency signal; the board keeps one line
        // per agent per interval so a busy agent cannot drown the feed.
        if (now - (card.lastToolFeedAt ?? 0) >= TOOL_FEED_INTERVAL_MS && data.name !== 'hub_post' && data.name !== 'hub_read') {
          card.lastToolFeedAt = now
          this.append(board.sessionId, {
            kind: 'progress',
            from: card.id,
            fromName: card.name,
            agentId: card.id,
            text: card.activity,
          })
        }
        this.#emitAgentSoon(board.sessionId, card)
        return
      }
      case 'assistant/message': {
        // The committed message carries the whole step, so the token-level
        // buffer that produced it is cleared here rather than appended twice.
        card.live = ''
        const text = textFromBlocks(data.message?.content)
        if (text !== '') card.output = tail(card.output, text, this.settings.outputLimit)
        const usage = data.usage
        if (usage !== null && typeof usage === 'object') {
          card.usage = {
            input: (card.usage?.input ?? 0) + numberOr(usage.inputTokens, 0),
            output: (card.usage?.output ?? 0) + numberOr(usage.outputTokens, 0),
          }
        }
        card.activity = data.interrupted === true ? '这一轮被打断' : '完成了一步并给出回复'
        this.#emitAgentSoon(board.sessionId, card)
        return
      }
      case 'turn/end': {
        const reason = data.reason?.kind ?? 'stop'
        if (reason === 'error') {
          card.status = 'error'
          card.error = oneLine(data.reason?.failure?.message ?? '这一轮以错误结束', 200)
          this.append(board.sessionId, {
            kind: 'system', from: 'system', fromName: '系统', agentId: card.id,
            text: `${card.name} 这一轮出错：${card.error}`,
          })
        } else {
          card.activity = reason === 'aborted' ? '这一轮被取消' : '这一轮结束'
        }
        this.#emitAgent(board.sessionId, card)
        return
      }
      default:
        return
    }
  }

  /**
   * Fold one live assistant-stream frame into a card's in-flight text.
   *
   * This is the only token-level signal the hub gets: `session/event` carries
   * committed work only, so without this the board would advance one step at a
   * time instead of one token at a time. Chunk frames can arrive far faster
   * than a screen repaints, so they take the coalescing emitter.
   * @param {Record<string, any>} agent - Agent whose attempt produced the frame.
   * @param {Record<string, any>} frame - One start, chunk, or end publication.
   * @returns {void}
   */
  noteAssistantStream(agent, frame) {
    const located = this.#locate(agent?.id)
    if (located === null || located.card === null) return
    const { board, card } = located
    if (frame?.type === 'start') {
      card.live = ''
      card.status = 'running'
      card.activity = '正在生成回复'
      card.lastActivityAt = Date.now()
      this.#emitAgentSoon(board.sessionId, card)
      return
    }
    if (frame?.type === 'end') {
      // The committed `assistant/message` that follows clears `live`;
      // keeping the tail until then avoids a flicker between the two events.
      return
    }
    const chunk = frame?.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    card.live = streamTail(card.live ?? '', chunk.text, this.settings.outputLimit)
    card.status = 'running'
    card.lastActivityAt = Date.now()
    this.#emitAgentSoon(board.sessionId, card)
  }

  /**
   * Mirror the process-local agent status.
   * @param {Record<string, any>} payload - `agent/status` payload.
   * @returns {void}
   */
  noteAgentStatus(payload) {
    const located = this.#locate(payload?.agent?.id)
    if (located === null || located.card === null) return
    const { board, card } = located
    const status = payload?.status ?? payload?.agent?.status
    if (status === 'running') {
      card.status = 'running'
      card.startedAt ??= Date.now()
    } else if (status === 'idle' && card.status === 'running') {
      // An idle child finished its turn but keeps its identity and inbox, so
      // it is "waiting", not "done": a terminal status comes from
      // `subagent/end` alone.
      card.status = 'idle'
      card.activity = card.activity === '' ? '等待下一步' : card.activity
    }
    card.lastActivityAt = Date.now()
    this.#emitAgentSoon(board.sessionId, card)
  }

  /**
   * Mark a child as just published.
   * @param {Record<string, any>} info - `subagent/start` payload.
   * @returns {void}
   */
  noteSubagentStart(info) {
    const located = this.#locate(info?.id)
    if (located === null || located.card === null) return
    located.card.status = 'running'
    located.card.startedAt ??= Date.now()
    this.#emitAgent(located.board.sessionId, located.card)
  }

  /**
   * Settle a child: this is the only source of a terminal card status.
   * @param {Record<string, any>} info - `subagent/end` payload.
   * @returns {void}
   */
  noteSubagentEnd(info) {
    const located = this.#locate(info?.id)
    if (located === null || located.card === null) return
    const { board, card } = located
    const stopReason = info?.stopReason ?? 'completed'
    card.status = stopReason === 'completed' ? 'done' : (stopReason === 'aborted' ? 'stopped' : 'error')
    card.endedAt = Date.now()
    card.activity = card.status === 'done' ? '任务完成' : (card.status === 'stopped' ? '已停止' : '出错结束')
    if (card.status === 'error' && typeof card.error !== 'string') card.error = `子智能体以 ${stopReason} 结束`
    const summary = oneLine(textFromBlocks(info?.lastAssistantMessage), 200)
    this.append(board.sessionId, {
      kind: 'system',
      from: 'system',
      fromName: '系统',
      agentId: card.id,
      text: summary === ''
        ? `${card.name} · ${card.activity}`
        : `${card.name} · ${card.activity}：${summary}`,
    })
    this.#emitAgent(board.sessionId, card)
    this.#emitBoard(board)
    // Close the durable task this agent was published as. Fire-and-forget on
    // purpose: the board update the user is watching must not wait on a
    // compare-and-set that may be racing the model's own task edits.
    void settleTask(this.ctx, board.sessionId, card).then(outcome => {
      if (outcome.error !== null) this.#noteTeamWarning(board, `原生任务收尾失败：${outcome.error}`)
      else if (outcome.completed) this.#emitAgent(board.sessionId, card)
    }).catch(() => {
      // A rejection here is already reported through the warning path above.
    })
  }

  /**
   * Release every timer this hub owns. Called when the plugin unloads.
   * @returns {void}
   */
  dispose() {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#dirty.clear()
    this.#subscribers.clear()
    this.#children.clear()
  }

  /** Resolve one route for the coordinator call. */
  async #resolveRoute(sessionId, explicit) {
    const provider = typeof explicit?.provider === 'string' ? explicit.provider.trim() : ''
    const model = typeof explicit?.model === 'string' ? explicit.model.trim() : ''
    if (provider !== '' && model !== '') return { provider, model }
    const live = this.ctx.get?.('agents')?.get?.(sessionId)
    const config = live?.session?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string'
      && config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
    const { providers } = await this.catalog()
    for (const entry of providers) {
      const first = entry.models[0]
      if (first !== undefined) return { provider: entry.provider, model: first.id }
    }
    throw new HubError(503, '没有可用的模型路由：既拿不到本会话的模型，也没有任何已注册的 provider')
  }

  /** Pick the subagent provider name to use. */
  #pickProvider() {
    const available = this.providers()
    if (available.length === 0) throw new HubError(503, '没有已注册的子智能体 provider')
    if (this.settings.provider !== '' && available.includes(this.settings.provider)) return this.settings.provider
    return available[0]
  }

  /** Resolve the live parent agent, with an actionable message when absent. */
  #liveParent(sessionId) {
    const agents = this.ctx.get?.('agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined || agent === null) {
      throw new HubError(
        409,
        '这个会话当前没有活动的智能体，无法派发子智能体。请在对话里发一条消息（哪怕一个字）让会话激活，再回到协作台启动。',
      )
    }
    return agent
  }

  /**
   * Translate powers into a `tools.restrict()` filter.
   *
   * Only names that exist in the live registry are put in the filter: naming an
   * unregistered tool there throws, so a guess like `bash` on a deployment that
   * never loads a shell tool would break every launch.
   */
  #toolFilter(powers) {
    const tools = this.ctx.get?.('tools')
    const present = name => {
      try {
        return tools?.get?.(name) !== undefined
      } catch {
        return false
      }
    }
    const existing = names => names.filter(present)
    if (powers.write && powers.shell) return undefined
    if (!powers.write && !powers.shell) {
      // A whitelist is the only honest "read-only": enumerating every write
      // tool that might exist somewhere is not possible, so deny by default.
      const allow = existing(READ_ONLY_TOOLS)
      return allow.length > 0 ? { allow } : { deny: existing([...WRITE_TOOLS, ...SHELL_TOOLS]) }
    }
    const deny = existing(powers.write ? SHELL_TOOLS : [...WRITE_TOOLS, ...SHELL_TOOLS])
    return deny.length > 0 ? { deny } : undefined
  }

  /** Deliver one message into a child's inbox through the live parent. */
  async #deliver(sessionId, card, text, delivery, source, sourceName, signal) {
    const subagents = this.ctx.get?.('subagents')
    if (subagents === undefined || typeof subagents.prompt !== 'function') {
      throw new HubError(503, '子智能体服务不可用')
    }
    // The parent must be live for the delivery to be authorized; resolving it
    // here turns "parent went away" into the same actionable 409 as launch.
    this.#liveParent(sessionId)
    try {
      const receipt = await subagents.prompt({
        parentSessionId: sessionId,
        childSessionId: card.id,
        delivery,
        requestId: `hub-${randomUUID()}`,
        content: [{ type: 'text', text }],
      }, signal ?? new AbortController().signal)
      if (card.status === 'idle' || TERMINAL_STATUSES.has(card.status)) {
        card.status = 'running'
        card.activity = source === 'agent' ? `收到 ${sourceName} 的消息` : '收到你的消息'
      }
      card.endedAt = null
      this.#emitAgent(sessionId, card)
      return receipt?.messageId ?? null
    } catch (error) {
      throw new HubError(502, `投递失败：${messageOf(error)}`)
    }
  }

  /**
   * Locate a session on the boards.
   *
   * The boundary this feature draws is the **board**, not the roster: anything
   * belonging to a conversation resolves to that conversation's board, and nothing
   * resolves to any other conversation's board. That is why the last branch exists
   * — a subagent of a subagent is still on the same board and reads it as a
   * participant, where refusing it would teach the model that the board is
   * sometimes there and sometimes not.
   * @param {string} sessionId - A board owner or any of its descendants.
   * @returns {{ board: Record<string, any>, card: Record<string, any>|null }|null} Location, or null when unknown.
   */
  #locate(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const direct = this.#boards.get(sessionId)
    if (direct !== undefined) return { board: direct, card: null }
    const link = this.#children.get(sessionId)
    if (link !== undefined) {
      const board = this.#boards.get(link.sessionId)
      if (board === undefined) return null
      const card = board.agents.find(agent => agent.clientId === link.clientId)
      return card === undefined ? null : { board, card }
    }
    const owner = this.#boardSessionOf(sessionId)
    if (owner === sessionId) return null
    // A **direct** child of the conversation that the hub is not tracking was
    // launched and then replaced — a re-launch, or a cleared board — so its access
    // is revoked along with its card, and reporting "not on any board" is the
    // honest answer. A deeper descendant, one of our own agents' subagents, is a
    // participant of the same board and reads it as one.
    const parent = this.ctx.get?.('agents')?.get?.(sessionId)?.session?.header?.parentSession
    if (parent === owner) return null
    const board = this.#boards.get(owner)
    return board === undefined ? null : { board, card: null }
  }

  /**
   * How to name a speaker that has no card on the board.
   * @param {Record<string, any>} board - The board.
   * @param {string} sessionId - Speaking session.
   * @param {Record<string, any>|null} card - The speaker's card, when it has one.
   * @returns {string} Display name.
   */
  #speakerName(board, sessionId, card) {
    if (card !== null) return card.name
    // The conversation itself, or a subagent of it that the hub did not launch.
    // Calling both "父会话" would misattribute a grandchild's words.
    return sessionId === board.sessionId ? '父会话' : '子智能体'
  }

  /**
   * Swap a board's roster, dropping the child index entries it no longer owns.
   *
   * Without the purge, a replaced agent's events would still resolve — to the
   * new card that happens to carry the same local id — and the board would
   * report one agent's work as another's.
   * @param {Record<string, any>} board - The board.
   * @param {Record<string, any>[]} cards - The replacement roster.
   * @returns {void}
   */
  #replaceAgents(board, cards) {
    for (const previous of board.agents) {
      if (previous.id !== null) this.#children.delete(previous.id)
    }
    board.agents = cards
  }

  #emit(sessionId, event, data) {
    const set = this.#subscribers.get(sessionId)
    if (set === undefined) return
    for (const send of [...set]) {
      try {
        send(event, data)
      } catch {
        // A dead subscriber (a closed socket) must not break the others.
        set.delete(send)
      }
    }
  }

  #emitBoard(board) {
    this.#emit(board.sessionId, 'board', {
      sessionId: board.sessionId,
      objective: board.objective,
      phase: phaseOf(board),
      ...(board.teamWarning === undefined || board.teamWarning === null ? {} : { teamWarning: board.teamWarning }),
    })
  }

  /**
   * Record one non-fatal failure of the Agent Teams bridge.
   *
   * It goes to the board's own warning slot rather than the feed: these repeat on
   * every settle, and a feed filling with retry noise would bury the agents'
   * actual progress. It stays visible through `state().team.warning`.
   * @param {Record<string, any>} board - The board.
   * @param {string} message - What failed.
   * @returns {void}
   */
  #noteTeamWarning(board, message) {
    board.teamWarning = message
    this.ctx.logger?.warn?.(`agent-hub: ${message}`)
    this.#emitBoard(board)
  }

  /** Emit one card immediately; used for state changes a human is waiting on. */
  #emitAgent(sessionId, card) {
    this.#emit(sessionId, 'agent', { ...card })
  }

  /** Coalesce card frames for high-frequency updates. */
  #emitAgentSoon(sessionId, card) {
    let set = this.#dirty.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.#dirty.set(sessionId, set)
    }
    set.add(card.clientId)
    if (this.#timers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.#timers.delete(sessionId)
      const pending = this.#dirty.get(sessionId)
      if (pending === undefined) return
      this.#dirty.delete(sessionId)
      const board = this.#boards.get(sessionId)
      if (board === undefined) return
      for (const clientId of pending) {
        const found = board.agents.find(agent => agent.clientId === clientId)
        if (found !== undefined) this.#emitAgent(sessionId, found)
      }
    }, FRAME_COALESCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this.#timers.set(sessionId, timer)
  }
}

/**
 * Derive the board phase from its cards.
 * @param {Record<string, any>} board - The board.
 * @returns {'idle'|'planned'|'running'|'done'} Phase.
 */
export function phaseOf(board) {
  const agents = board?.agents ?? []
  if (agents.length === 0) return 'idle'
  if (agents.some(card => card.status === 'running' || card.status === 'queued')) return 'running'
  if (agents.every(card => card.status === 'draft')) return 'planned'
  if (agents.every(card => TERMINAL_STATUSES.has(card.status))) return 'done'
  // A mix of idle and terminal cards is still a live team: someone can be woken.
  return 'running'
}

/**
 * Build one card from a draft or launch row.
 * @param {Record<string, any>} spec - Row from the coordinator or the UI.
 * @param {number} index - Position, used for the fallback name.
 * @param {Record<string, any>} settings - Normalized config.
 * @returns {Record<string, any>} A fresh card.
 */
export function createCard(spec, index, settings) {
  const powers = spec?.powers ?? {}
  return {
    clientId: typeof spec?.clientId === 'string' && spec.clientId !== '' ? spec.clientId : `a${index + 1}`,
    id: null,
    name: oneLine(spec?.name ?? `智能体 ${index + 1}`, 40),
    role: oneLine(spec?.role ?? '', 160),
    task: String(spec?.task ?? '').trim(),
    model: {
      provider: typeof spec?.model?.provider === 'string' ? spec.model.provider : '',
      model: typeof spec?.model?.model === 'string' ? spec.model.model : '',
      reasoningEffort: typeof spec?.model?.reasoningEffort === 'string' ? spec.model.reasoningEffort : null,
    },
    powers: {
      // Reading is the floor: there is no configuration in which an agent that
      // cannot read is useful, so the flag is always true and not offered.
      read: true,
      write: powers.write === undefined ? settings.defaultWrite : powers.write === true,
      shell: powers.shell === undefined ? settings.defaultShell : powers.shell === true,
      message: powers.message === undefined ? true : powers.message === true,
    },
    files: Array.isArray(spec?.files) ? spec.files.filter(file => typeof file === 'string').slice(0, 20) : [],
    status: 'draft',
    activity: '',
    output: '',
    // In-flight assistant text, assembled from `agent/assistant-stream` deltas.
    // It is deliberately separate from `output`: `output` holds committed steps
    // only, so a UI can style "still typing" differently from "already said".
    live: '',
    usage: { input: 0, output: 0 },
    toolCalls: 0,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    lastActivityAt: 0,
    lastToolFeedAt: 0,
    error: null,
  }
}

/**
 * Find one card by child id or local id.
 * @param {Record<string, any>} board - The board.
 * @param {string} key - Child session id or `clientId`.
 * @returns {Record<string, any>} The card.
 * @throws {HubError} 404 when nothing matches.
 */
export function findCard(board, key) {
  const card = board.agents.find(agent => agent.id === key || agent.clientId === key)
  if (card === undefined) throw new HubError(404, `找不到智能体 ${String(key)}`)
  return card
}

/**
 * Find a peer the way a model addresses one: by name first.
 *
 * A model only ever sees the roster as names, so `hub_post({to: '评审'})` is the
 * natural call; matching ids only would make the documented usage fail. Names
 * are matched exactly first and case-insensitively after, and an ambiguous name
 * is refused rather than guessed.
 * @param {Record<string, any>} board - The board.
 * @param {string} key - Teammate name, child id, or local id.
 * @returns {Record<string, any>} The card.
 * @throws {HubError} 404 when nothing matches, 409 when the name is ambiguous.
 */
export function findPeer(board, key) {
  const needle = String(key ?? '').trim()
  if (needle === '') throw new HubError(400, 'to 不能是空字符串')
  const byId = board.agents.find(agent => agent.id === needle || agent.clientId === needle)
  if (byId !== undefined) return byId
  const exact = board.agents.filter(agent => agent.name === needle)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new HubError(409, `有两个同伴都叫「${needle}」，请用更明确的名字`)
  const loose = board.agents.filter(agent => agent.name.toLowerCase() === needle.toLowerCase())
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) throw new HubError(409, `有两个同伴都叫「${needle}」，请用更明确的名字`)
  const known = board.agents.map(agent => agent.name).join('、')
  throw new HubError(404, `找不到同伴「${needle}」；当前同伴：${known === '' ? '（无）' : known}`)
}

/** Map one card to `agentOptions`, or undefined when no route was chosen. */
function agentOptionsOf(card) {
  if (card.model.provider === '' || card.model.model === '') return undefined
  return {
    provider: card.model.provider,
    model: card.model.model,
    ...(card.model.reasoningEffort === null ? {} : { reasoningEffort: card.model.reasoningEffort }),
  }
}

/** Validate one launch row, loudly. */
function validateSpec(spec, index) {
  const where = `第 ${index + 1} 个智能体`
  if (spec === null || typeof spec !== 'object') throw new HubError(400, `${where} 不是对象`)
  if (typeof spec.task !== 'string' || spec.task.trim() === '') throw new HubError(400, `${where} 缺少 task`)
  const provider = spec.model?.provider
  const model = spec.model?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new HubError(400, `${where} 没有选择模型`)
  }
}

/** Resolve a requested agent count, rejecting rather than silently clamping. */
function clampCount(value, max) {
  if (value === undefined || value === null) return Math.min(4, max)
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HubError(400, 'count 必须是正整数')
  }
  if (value < 1 || value > max) throw new HubError(400, `count 必须在 1 到 ${max} 之间`)
  return value
}

/** Describe one tool call as a short human line. */
function toolDetail(name, rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments === '') return `调用 ${name}`
  let args
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return `调用 ${name}`
  }
  const path = args?.path ?? args?.file_path ?? args?.filePath
  if (typeof path === 'string' && path !== '') return `处理 ${oneLine(path, 90)}`
  const command = args?.command ?? args?.cmd
  if (typeof command === 'string' && command !== '') return `执行：${oneLine(command, 70)}`
  const pattern = args?.pattern
  if (typeof pattern === 'string' && pattern !== '') return `检索 ${oneLine(pattern, 60)}`
  return `调用 ${name}`
}

/** Coerce a possibly-missing numeric token count. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read a message out of anything thrown. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
