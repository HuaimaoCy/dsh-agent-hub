/**
 * dsh-agent-hub, browser half: the 协作台 (Agent Hub) sidebar entry, the panel it
 * opens in the central column, the conversation-bound view tab, and the summary
 * the composer carries.
 *
 * What this half owns: turning one conversation into a *board* of parallel
 * sub-agents — split an objective into roles, edit the split by hand, launch it,
 * then watch every lane's status, activity, output tail and token usage while
 * the feed interleaves what the agents say to each other and what the human
 * says back.
 *
 * **Why a same-origin route and not a Typert Remote namespace.** Mounting a
 * Remote namespace would require this bundle to take part in the harness's
 * Client assembly build, which an out-of-tree plugin cannot join. The Host half
 * therefore registers its own route (`/agent-hub`) and this half calls it with
 * `fetch`. Two consequences are load-bearing:
 *
 * 1. The **live stream is `EventSource`** (`?op=stream`). `EventSource` cannot
 *    attach request headers, so the stream endpoint is a GET the Host half
 *    deliberately does not require the marker header on; every *write* still
 *    goes through `fetch` with `x-dsh-agent-hub: 1`, which is also what forces a
 *    CORS preflight off-origin and blocks a cross-site form from driving the
 *    board.
 * 2. **`agent` frames carry a complete AgentCard, not a patch.** Merging is
 *    overwrite-by-identity (`id ?? clientId`), never a field-level merge — a
 *    patch merge would silently keep a stale `status` or a stale `error`.
 *
 * Presentation is built from the shell's own primitives
 * (`@deepseek-ai/dsh-client-ui-primitives`) and its design tokens (`--dsw-*`),
 * so the panel inherits the application's typography, spacing, colors and
 * light/dark theming instead of approximating them.
 *
 * This file is the built artifact shape written by hand: a CJS closure handed to
 * `window.__ModuleLoader__.load`, requiring only the browser module table's
 * baseline specifiers so no second copy of React can appear. No JSX, no bundler,
 * and every element built with `React.createElement`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-hub',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Pill, Tag, Input, Checkbox, DisclosureRow, StateDot, relativeTime,
      IconPlusOutlineMedium, IconTrashOutlineMedium, IconRefreshOutlineMedium, IconPlayOutlineMedium,
      IconStopFillMedium, IconCopyOutlineMedium, IconChevronUpOutlineMedium, IconChevronDownOutlineMedium,
      IconPaperPlaneOutlineMedium, IconLoadingOutlineMedium, IconUsersOutlineMedium,
      IconQueueOutlineMedium, IconSparkleMedium, IconClockOutlineMedium, IconAgentPresetOutlineMedium,
    } = primitives
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'agentHub'
    /** Panel id shared by the sidebar entry and the main-column page. */
    const PANEL_ID = 'agent-hub'
    /** Same-origin route registered by the Host half. */
    const ENDPOINT = '/agent-hub'
    /** Marker header the Host requires on writes; also forces a CORS preflight off-origin. */
    const MARKER = 'x-dsh-agent-hub'
    /** `launch` accepts at most this many agents (mirrors the Host's default maxAgents). */
    const MAX_AGENTS = 8
    /** How many feed rows are kept; the Host sends at most 200 per snapshot. */
    const FEED_CAP = 200
    /** Reconnect backoff: first delay, growth factor, and ceiling in milliseconds. */
    const RETRY_BASE_MS = 1000
    const RETRY_FACTOR = 1.7
    const RETRY_MAX_MS = 15000
    /**
     * Fallback cadence when the stream cannot stay up, in milliseconds.
     *
     * SSE through a plugin-owned route is not guaranteed to survive every server
     * or proxy configuration. "No live updates at all" is a far worse outcome
     * than a slightly stale board, so after {@link POLL_AFTER_FAILURES}
     * consecutive failures the panel keeps itself current with full-state reads
     * while still trying to re-open the stream underneath.
     */
    const POLL_INTERVAL_MS = 2000
    const POLL_AFTER_FAILURES = 3
    /** How close to the bottom still counts as "the reader is following the tail". */
    const PIN_SLACK_PX = 24
    /** Coarse lifecycle buckets a lane header reports. */
    const TERMINAL_STATUSES = ['done', 'error', 'stopped']
    /** Status vocabulary, so the label map and the tone map cannot drift apart. */
    const STATUS_KEYS = {
      draft: 'draftStatus', queued: 'queued', running: 'running',
      idle: 'idle', done: 'done', error: 'error', stopped: 'stopped',
    }
    /**
     * Reasoning efforts offered per agent.
     *
     * `op=models` reports provider and model but no effort vocabulary, so this
     * is the one place the client carries a fixed list of its own; the empty
     * value is "whatever the provider defaults to" and is the default. When the
     * catalogue grows an `efforts` array this list should be replaced by it.
     */
    const EFFORTS = ['', 'off', 'low', 'high', 'max']

    const STRINGS = {
      zh: {
        panel: '协作台', viewTitle: '协作台', title: '协作台',
        subtitle: '把目标拆成一组并行子智能体，在同一块进度板上看它们的分工、输出与对话。',
        objective: '目标', objectivePlaceholder: '一句话说明要完成什么，例如：把构建脚本迁移到 pnpm',
        draft: '智能拆分', drafting: '拆分中…', addAgent: '添加智能体',
        launchCount: '并行启动（{n}）', editing: '回到分工草案', clear: '清空草案',
        refresh: '刷新', stopAll: '全部停止', online: '在线',
        reconnecting: '重连中', connecting: '连接中', polling: '轮询', streamRetry: '进度流已断开，正在重连…',
        backoff: '{s} 秒后重试', noSession: '还没有可用的会话：先开始一个对话，协作台会跟着那个会话走。',
        sessionPick: '选择会话', bindHint: '这块协作台绑定的是 {name}。',
        draftEmpty: '还没有分工草案：填好目标点「智能拆分」，或者手动「添加智能体」。',
        draftHint: '「智能拆分」需要宿主能调用协调者模型；不可用时请手动添加。',
        noLLM: '这个部署没有可用的协调者模型，无法智能拆分，请手动添加智能体。',
        needObjective: '请先填写目标。', running: '运行中', idle: '空闲',
        stopped: '已停止', done: '已完成', error: '出错',
        draftStatus: '未启动', queued: '待启动', name: '名称',
        role: '角色', subTask: '子任务', files: '文件范围',
        filesPlaceholder: 'src/**, tests/**（逗号分隔）', model: '模型', effort: '推理等级',
        effortDefault: '默认', powerRead: '只读', powerWrite: '写入文件',
        powerShell: '执行命令', powerMessage: '可与同伴通信', readAlways: '只读恒开，不提供关闭',
        provider: '提供方', pickModel: '选择模型', loadingModels: '加载模型中…',
        noModels: '没有可用模型。', moveUp: '上移', moveDown: '下移',
        duplicate: '复制', remove: '删除', advanced: '模型与权限',
        errName: '名称不能为空', errTask: '子任务不能为空', errModel: '还没有选择模型',
        errEmpty: '至少要有一个智能体', errTooMany: '最多 {n} 个智能体',
        laneTask: '子任务', laneScope: '文件范围', output: '输出',
        outputEmpty: '（还没有输出）', activity: '当前动作', activityIdle: '尚未开始',
        tokens: 'Token', tokensInOut: '入 {in} · 出 {out}', elapsed: '已运行',
        elapsedNotStarted: '未启动', follow: '回到底部', steer: '插话',
        steerPlaceholder: '给这个智能体一句话…', steerSend: '发送', steerCancel: '取消',
        delivery: '投递方式', deliveryQueue: '排队', deliverySteer: '立即插话',
        deliveryHint: '排队等它当前一步结束；立即插话会打断当前推理。',
        wake: '唤醒', interrupt: '中断', unavailableDraft: '智能体还没启动，这个操作不可用。',
        leadNote: '主智能体 · 就在这个对话里',
        feed: '进度板', feedEmpty: '还没有进度。', feedAll: '全体',
        teamBoard: '原生团队', teamCounts: '{a} 个成员 · {b} 个待办',
        teamNoTasks: '原生任务板上没有待办。', taskActive: '进行中', taskPending: '待办',
        taskBlocked: '依赖 {ids}',
        broadcast: '广播', broadcastPlaceholder: '发给所有智能体…', broadcastToAll: '默认发给全体',
        kindPlan: '方案', kindProgress: '进度', kindMessage: '消息',
        kindHandoff: '交接', kindHuman: '人工', kindSystem: '系统',
        unread: '未读', hubOpen: '打开协作台', dockIdle: '用协作台并行处理',
        dockCount: '{n} 个智能体中 {m} 个运行中', dockDone: '{n} 个智能体已结束',
        sent: '已发送。', accepted: '已受理。', stoppedNotice: '已请求停止 {n} 个智能体。',
        recent: '最近的会话', timeNow: '刚刚', timeMinutes: '{n}分钟',
        timeHours: '{n}小时', timeDays: '{n}天', timeMonths: '{n}个月', timeYears: '{n}年',
      },
      en: {
        panel: 'Agent Hub', viewTitle: 'Agent Hub', title: 'Agent Hub',
        subtitle: 'Split one objective into parallel sub-agents and watch their assignments, output and chatter on one board.',
        objective: 'Objective', objectivePlaceholder: 'One line on what must get done, e.g. migrate the build scripts to pnpm',
        draft: 'Split with the model', drafting: 'Splitting…', addAgent: 'Add agent',
        launchCount: 'Launch all ({n})', editing: 'Back to the plan', clear: 'Discard plan',
        refresh: 'Refresh', stopAll: 'Stop all', online: 'Live',
        reconnecting: 'Reconnecting', connecting: 'Connecting', polling: 'Polling', streamRetry: 'The progress stream dropped; reconnecting…',
        backoff: 'retrying in {s}s', noSession: 'No conversation yet: start one and the hub follows it.',
        sessionPick: 'Conversation', bindHint: 'This board follows {name}.',
        draftEmpty: 'No plan yet: fill in the objective and press "Split with the model", or add agents by hand.',
        draftHint: '"Split with the model" needs a coordinator model on the Host; add rows by hand when it is unavailable.',
        noLLM: 'This deployment has no coordinator model, so splitting is unavailable — add agents by hand.',
        needObjective: 'Fill in the objective first.', running: 'Running', idle: 'Idle',
        stopped: 'Stopped', done: 'Done', error: 'Error',
        draftStatus: 'Not started', queued: 'Queued', name: 'Name',
        role: 'Role', subTask: 'Task', files: 'File scope',
        filesPlaceholder: 'src/**, tests/** (comma separated)', model: 'Model', effort: 'Reasoning effort',
        effortDefault: 'Default', powerRead: 'Read', powerWrite: 'Write files',
        powerShell: 'Run commands', powerMessage: 'Talk to peers', readAlways: 'reading is always on and cannot be turned off',
        provider: 'Provider', pickModel: 'Pick a model', loadingModels: 'Loading models…',
        noModels: 'No models available.', moveUp: 'Move up', moveDown: 'Move down',
        duplicate: 'Duplicate', remove: 'Delete', advanced: 'Model and powers',
        errName: 'Name is required', errTask: 'Task is required', errModel: 'No model selected',
        errEmpty: 'At least one agent is required', errTooMany: 'At most {n} agents',
        laneTask: 'Task', laneScope: 'File scope', output: 'Output',
        outputEmpty: '(no output yet)', activity: 'Current step', activityIdle: 'Not started',
        tokens: 'Tokens', tokensInOut: 'in {in} · out {out}', elapsed: 'Elapsed',
        elapsedNotStarted: 'not started', follow: 'Jump to the tail', steer: 'Message',
        steerPlaceholder: 'One line for this agent…', steerSend: 'Send', steerCancel: 'Cancel',
        delivery: 'Delivery', deliveryQueue: 'Queue', deliverySteer: 'Interrupt now',
        deliveryHint: 'Queueing waits for the current step; interrupting cuts into the running turn.',
        wake: 'Wake', interrupt: 'Interrupt', unavailableDraft: 'This agent has not started, so the action is unavailable.',
        leadNote: 'the lead agent · in this conversation',
        feed: 'Progress', feedEmpty: 'Nothing has happened yet.', feedAll: 'everyone',
        teamBoard: 'Agent Teams', teamCounts: '{a} members · {b} open tasks',
        teamNoTasks: 'No open tasks on the team board.', taskActive: 'in progress', taskPending: 'pending',
        taskBlocked: 'blocked by {ids}',
        broadcast: 'Broadcast', broadcastPlaceholder: 'To every agent…', broadcastToAll: 'goes to everyone by default',
        kindPlan: 'Plan', kindProgress: 'Progress', kindMessage: 'Message',
        kindHandoff: 'Handoff', kindHuman: 'Human', kindSystem: 'System',
        unread: 'unread', hubOpen: 'Open the hub', dockIdle: 'Run it in parallel with the Agent Hub',
        dockCount: '{m} of {n} agents running', dockDone: '{n} agents finished',
        sent: 'Sent.', accepted: 'Accepted.', stoppedNotice: 'Asked {n} agents to stop.',
        recent: 'Recent conversations', timeNow: 'just now', timeMinutes: '{n}min',
        timeHours: '{n}h', timeDays: '{n}d', timeMonths: '{n}mo', timeYears: '{n}y',
      },
    }

    /* ------------------------------------------------------------------ *
     * Data layer: pure functions only, no IO
     * ------------------------------------------------------------------ */

    /** Translate one key against the built-in dictionary, `{name}` params and all. */
    function fallbackT() {
      const dict = STRINGS.zh
      return (key, params) => {
        const template = dict[key] ?? key
        if (params === undefined || params === null) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    }

    /**
     * An empty board. `phase` is present from the start because the first frame
     * arrives asynchronously and the page must render the 编排态 before it lands.
     */
    function emptyState(sessionId) {
      return {
        sessionId: String(sessionId ?? ''), objective: '', phase: 'idle', agents: [],
        feed: [], providers: [], hasLLM: false,
        // The harness's own Agent Teams state, read by the Host half. `null` means
        // "no snapshot yet", which the panel keeps distinct from a readable-but-empty
        // team.
        team: null,
        // The conversation's own agent, which the Host half keeps out of `agents`.
        lead: null,
        now: 0,
      }
    }

    /**
     * Identity of one agent card or draft row. A started agent has both a durable
     * `id` and its `clientId`, and frames may populate either, so the merge and
     * every React key read identity through this one function.
     */
    function identityOf(card) {
      const id = card?.id
      if (typeof id === 'string' && id !== '') return id
      const clientId = card?.clientId
      return typeof clientId === 'string' ? clientId : ''
    }

    /**
     * Merge one complete AgentCard into the roster. Overwrite, never patch: the
     * Host sends the whole card, and a field-level merge would leave a stale
     * `status` or `error` behind when a card returns to a simpler state.
     */
    function mergeAgent(agents, card) {
      const list = Array.isArray(agents) ? agents : []
      if (card === null || typeof card !== 'object') return list
      const key = identityOf(card)
      if (key === '') return list
      const index = list.findIndex(entry => entry !== null && typeof entry === 'object'
        && (identityOf(entry) === key || (entry.clientId !== undefined && entry.clientId === card.clientId)))
      if (index < 0) return [...list, card]
      const next = [...list]
      next[index] = card
      return next
    }

    /**
     * Append one feed item, de-duplicated by id. The snapshot and a live `feed`
     * frame can describe the same item — it can be emitted between the Host's
     * subscribe and its snapshot write — and a duplicate key would also make
     * React re-use the wrong row.
     */
    function appendFeed(feed, item) {
      const list = Array.isArray(feed) ? feed : []
      if (item === null || typeof item !== 'object') return list
      const id = item.id
      if (typeof id === 'string' && id !== '' && list.some(entry => entry?.id === id)) return list
      const next = [...list, item]
      return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next
    }

    /**
     * Apply one SSE frame. Unknown event names return the state unchanged rather
     * than throwing: the Host half may emit a new event before this file reloads.
     */
    function applyStreamEvent(state, eventName, data, fallbackNow) {
      const base = state === null || typeof state !== 'object' ? emptyState('') : state
      const payload = data === null || typeof data !== 'object' ? {} : data
      const now = (Number.isFinite(payload.now) ? payload.now : fallbackNow) ?? base.now ?? 0
      switch (eventName) {
        case 'snapshot':
          // A snapshot is authoritative for the board's contents but not for this
          // client's own fields, so only the known keys are replaced.
          return {
            ...base,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : base.sessionId,
            objective: typeof payload.objective === 'string' ? payload.objective : '',
            phase: typeof payload.phase === 'string' ? payload.phase : 'idle',
            agents: Array.isArray(payload.agents) ? payload.agents : [],
            feed: Array.isArray(payload.feed) ? payload.feed.slice(-FEED_CAP) : [],
            providers: Array.isArray(payload.providers) ? payload.providers : (base.providers ?? []),
            hasLLM: payload.hasLLM === undefined ? base.hasLLM === true : payload.hasLLM === true,
            team: payload.team === undefined || payload.team === null ? (base.team ?? null) : payload.team,
            lead: payload.lead === undefined || payload.lead === null ? (base.lead ?? null) : payload.lead,
            now,
          }
        case 'agent':
          return { ...base, agents: mergeAgent(base.agents, payload), now }
        case 'feed':
          return { ...base, feed: appendFeed(base.feed, payload), now }
        case 'lead':
          // The conversation's own card. It travels on its own event so a client
          // can never mistake it for something it may launch or steer.
          return { ...base, lead: payload, now }
        case 'board': {
          const next = { ...base, now }
          if (typeof payload.objective === 'string') next.objective = payload.objective
          if (typeof payload.phase === 'string') next.phase = payload.phase
          if (typeof payload.sessionId === 'string') next.sessionId = payload.sessionId
          // A board frame carries only a warning about the team bridge. It is
          // merged into the last team snapshot rather than replacing it, so a
          // failure stays visible between snapshots instead of blanking the panel.
          if (typeof payload.teamWarning === 'string' && payload.teamWarning !== '') {
            next.team = {
              available: true, readable: false, error: null, members: [], tasks: [],
              ...(base.team ?? {}),
              warning: payload.teamWarning,
            }
          }
          return next
        }
        case 'heartbeat':
          return { ...base, now }
        default:
          return base
      }
    }

    /** One default draft row; `index` only names it. */
    function newDraftRow(index) {
      const position = Number.isFinite(index) ? index : 0
      return {
        clientId: `a${String(position + 1)}`, name: `智能体 ${String(position + 1)}`, role: '', task: '',
        model: { provider: '', model: '', reasoningEffort: '' },
        powers: { read: true, write: true, shell: false, message: true },
        files: [],
      }
    }

    /**
     * Turn an AgentCard (or another draft row) into an editable draft row. Reading is the floor: the Host
     * half never sends `read: false` and the UI offers no way to turn it off, so it is forced true here.
     */
    function draftRowFromCard(card, index) {
      const row = newDraftRow(index)
      if (card === null || typeof card !== 'object') return row
      const model = card.model ?? {}
      const powers = card.powers ?? {}
      return {
        clientId: typeof card.clientId === 'string' && card.clientId !== '' ? card.clientId : row.clientId,
        name: typeof card.name === 'string' && card.name !== '' ? card.name : row.name,
        role: typeof card.role === 'string' ? card.role : '',
        task: typeof card.task === 'string' ? card.task : '',
        model: {
          provider: typeof model.provider === 'string' ? model.provider : '',
          model: typeof model.model === 'string' ? model.model : '',
          reasoningEffort: typeof model.reasoningEffort === 'string' ? model.reasoningEffort : '',
        },
        powers: { read: true, write: powers.write === true, shell: powers.shell === true, message: powers.message !== false },
        files: Array.isArray(card.files) ? card.files.filter(file => typeof file === 'string') : [],
      }
    }

    /**
     * The exact `launch` body one plan produces: trimmed, with `read` forced on,
     * so what the panel sends is what the Host half will accept.
     */
    function launchPayload(objective, rows) {
      const list = Array.isArray(rows) ? rows : []
      return {
        objective: String(objective ?? '').trim(),
        agents: list.map(row => ({
          clientId: identityOf(row),
          name: String(row.name ?? '').trim(),
          role: String(row.role ?? '').trim(),
          task: String(row.task ?? '').trim(),
          model: {
            provider: String(row.model?.provider ?? ''),
            model: String(row.model?.model ?? ''),
            ...(row.model?.reasoningEffort === undefined || row.model.reasoningEffort === ''
              ? {} : { reasoningEffort: row.model.reasoningEffort }),
          },
          powers: { ...row.powers, read: true },
          files: Array.isArray(row.files) ? [...row.files] : [],
        })),
      }
    }

    /**
     * The cards the plan editor may turn into a launch payload.
     *
     * Adopted agents — ones this conversation started outside the hub — are on the
     * board and get a lane, but they are not ours to re-launch, so they must never
     * become editable rows. Launching from them would dispatch a second copy of an
     * agent that is already running.
     */
    function planCards(state) {
      const agents = Array.isArray(state?.agents) ? state.agents : []
      return agents.filter(card => card?.origin !== 'adopted')
    }

    /** Build the `launch` payload from a board's current roster. */
    function draftFromState(state) {
      return launchPayload(
        typeof state?.objective === 'string' ? state.objective : '',
        planCards(state).map((card, index) => draftRowFromCard(card, index)),
      )
    }

    /**
     * Client-side validation of a plan.
     *
     * The Host half validates `task` and `model` again, but doing it here is what
     * lets the launch button stay disabled and each row name its own reason
     * instead of the whole call failing with a 400 afterwards. Keys are agent
     * identities; the two whole-list problems use `#`.
     */
    function validateDraft(agents) {
      const list = Array.isArray(agents) ? agents : []
      const errors = {}
      if (list.length === 0) errors['#'] = 'errEmpty'
      else if (list.length > MAX_AGENTS) errors['#'] = 'errTooMany'
      for (const row of list) {
        const key = identityOf(row)
        if (key === '') continue
        if (typeof row.name !== 'string' || row.name.trim() === '') errors[key] = 'errName'
        else if (typeof row.task !== 'string' || row.task.trim() === '') errors[key] = 'errTask'
        else if (typeof row.model?.provider !== 'string' || row.model.provider === ''
          || typeof row.model?.model !== 'string' || row.model.model === '') errors[key] = 'errModel'
      }
      return { ok: Object.keys(errors).length === 0, errors }
    }

    /** `12s` / `3m04s` / `1h02m`. */
    function formatElapsed(ms) {
      const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
      if (total < 60) return `${String(total)}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${String(minutes)}m${String(total % 60).padStart(2, '0')}s`
      return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`
    }

    /** `820` / `1.2k` / `12k` / `3.4M`. */
    function formatTokens(n) {
      const value = typeof n === 'number' && Number.isFinite(n) ? n : 0
      if (value < 1000) return String(Math.max(0, Math.round(value)))
      if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
      if (value < 1000000) return `${String(Math.round(value / 1000))}k`
      return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`
    }

    /** The `Tag` tone one status renders with. */
    function statusTone(status) {
      switch (status) {
        case 'running': return 'success'
        case 'idle': return 'info'
        case 'queued': return 'info'
        case 'error': return 'danger'
        case 'draft': return 'warning'
        default: return 'neutral'
      }
    }

    /**
     * The status dot appearance one status renders with. `done` uses the filled check rather than a grey
     * dot, so a finished lane is distinguishable from one that was never started.
     */
    function statusDot(status) {
      switch (status) {
        case 'running': return 'ongoing'
        case 'done': return 'done'
        case 'error': return 'error'
        case 'draft': return 'warning'
        default: return 'idle'
      }
    }

    /** Localized status label. */
    function statusLabel(status, t) {
      const key = STATUS_KEYS[status]
      return key === undefined ? String(status ?? '') : t(key)
    }

    /**
     * Derive the board phase from its cards. This mirrors the Host's own derivation so the panel switches
     * between the 编排态 and the 运行态 on a frame that only carried `agent` — a `board` frame is not guaranteed
     * to accompany every status change.
     */
    function phaseOf(state) {
      const agents = Array.isArray(state?.agents) ? state.agents : []
      if (agents.length === 0) return 'idle'
      if (agents.some(card => card?.status === 'running' || card?.status === 'queued')) return 'running'
      if (agents.every(card => card?.status === 'draft')) return 'planned'
      if (agents.every(card => TERMINAL_STATUSES.includes(card?.status))) return 'done'
      // Idle beside terminal cards is still a live team: someone can be woken.
      return 'running'
    }

    /** Flatten the model catalogue into lookup entries. */
    function modelEntries(catalog) {
      const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
      const entries = []
      for (const provider of providers) {
        if (provider === null || typeof provider !== 'object') continue
        const providerId = String(provider.provider ?? '')
        const providerName = typeof provider.name === 'string' && provider.name !== '' ? provider.name : providerId
        const models = Array.isArray(provider.models) ? provider.models : []
        // A provider with no reachable models still gets a row: hiding it would
        // make an unreachable backend look like a missing one.
        if (models.length === 0) {
          entries.push({ key: `${providerId}/`, provider: providerId, providerName, model: null, modelName: '', empty: true })
          continue
        }
        for (const model of models) {
          const modelId = String(model?.id ?? '')
          entries.push({
            key: `${providerId}/${modelId}`, provider: providerId, providerName, model: modelId,
            modelName: typeof model?.name === 'string' && model.name !== '' ? model.name : modelId, empty: false,
          })
        }
      }
      return entries
    }

    /** Localize a structured relative time: `刚刚`, `5分钟`, `3小时`. */
    function timeLabel(at, now, t) {
      const { unit, n } = relativeTime(at, now)
      if (unit === 'now') return t('timeNow')
      return t(`time${unit.charAt(0).toUpperCase()}${unit.slice(1)}`, { n })
    }

    /**
     * Call one Host-side hub operation. Reads pass `params` (query), writes pass `body` (JSON); the marker
     * header rides every call, which costs nothing and keeps one code path instead of two.
     */
    async function hostCall(op, params, body) {
      const base = typeof window !== 'undefined' && window.location !== undefined ? window.location.origin : undefined
      const url = base === undefined ? new URL(ENDPOINT, 'http://localhost') : new URL(ENDPOINT, base)
      if (typeof op === 'string' && op !== '') url.searchParams.set('op', op)
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, body === undefined
        ? { headers: { [MARKER]: '1' } }
        : {
            method: 'POST',
            headers: { [MARKER]: '1', 'content-type': 'application/json' },
            body: JSON.stringify({ op, ...body }),
          })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${String(response.status)}` }))
      if (payload.ok !== true) throw new Error(String(payload.error ?? `HTTP ${String(response.status)}`))
      return payload.result
    }

    /**
     * The plan-row mutators, shared by both board surfaces.
     *
     * Rows live in component state only once the human has touched them; until
     * then the plan is derived from the board. Every mutator therefore works on
     * `current ?? derived`, which is what lets a fresh arrangement survive while
     * an untouched one keeps following the server.
     */
    function planMutators(setRows, derived) {
      const take = (current) => [...(current ?? derived)]
      const indexOf = (list, key) => list.findIndex(row => identityOf(row) === key)
      return {
        patch: (key, patch) => {
          setRows(current => (current ?? derived).map(row => (identityOf(row) === key ? { ...row, ...patch } : row)))
        },
        move: (key, step) => {
          setRows((current) => {
            const list = take(current)
            const from = indexOf(list, key)
            const to = from + step
            if (from < 0 || to < 0 || to >= list.length) return list
            const [row] = list.splice(from, 1)
            list.splice(to, 0, row)
            return list
          })
        },
        duplicate: (key) => {
          setRows((current) => {
            const list = take(current)
            const at = indexOf(list, key)
            if (at < 0 || list.length >= MAX_AGENTS) return list
            const source = list[at]
            // A fresh clientId is not cosmetic: the id is the merge key, so a
            // duplicate sharing one would collapse two agents into one card.
            list.splice(at + 1, 0, {
              ...source, clientId: `${String(source.clientId ?? 'a')}c${String(list.length)}`,
              powers: { ...source.powers }, files: [...source.files],
            })
            return list
          })
        },
        remove: (key) => { setRows(current => (current ?? derived).filter(row => identityOf(row) !== key)) },
        add: () => {
          setRows((current) => {
            const list = take(current)
            return list.length >= MAX_AGENTS ? list : [...list, newDraftRow(list.length)]
          })
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Stylesheet
     * ------------------------------------------------------------------ */

    /** Stylesheet for the panel, rendered as an element so unmounting removes it. */
    function StyleSheet() {
      return h('style', null, `
.dsah, .dsah-dock {
  --dsah-ease-out: cubic-bezier(.23, 1, .32, 1);
  /* Type scales with the reader's text-size setting instead of a fixed px ladder,
     so the panel grows with the rest of the shell. */
  --dsah-fs-title: calc(var(--dsh-content-font-size, 14px) + 2px);
  --dsah-fs-small: calc(var(--dsh-content-font-size, 14px) - 2px);
  --dsah-fs-cap: calc(var(--dsh-content-font-size, 14px) - 3px);
  --dsah-lh-small: calc(var(--dsh-content-font-size, 14px) + 6px);
  --dsah-lh-body: calc(var(--dsh-content-font-size, 14px) + 8px);
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family);
}
.dsah { height: 100%; display: flex; flex-direction: column; }
.dsah-dock { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 0 2px 6px; max-width: 100%; }
/* One segment per launched agent, filled only when that agent has settled.
   Only opacity and background-color animate: both stay on the compositor, and
   neither can be mistaken for progress the data does not support. */
.dsah-track { display: inline-flex; gap: 3px; align-items: center; }
.dsah-seg {
  width: 14px; height: 4px; border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.3;
  transition: opacity 180ms ease, background-color 180ms ease;
}
.dsah-seg.is-running {
  background: var(--dsw-alias-link);
  /* A slow opacity breathe, not a sweeping shimmer: the sweep is motion the user
     cannot act on and cannot stop, and it draws the eye to a place where nothing
     is being asked of them. */
  animation: dsah-breathe 1.8s ease-in-out infinite;
}
.dsah-seg.is-done { background: var(--dsw-alias-state-success-primary); opacity: 1; }
.dsah-seg.is-failed { background: var(--dsw-alias-state-warn-primary); opacity: 1; }
@keyframes dsah-breathe { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  /* Reduced motion keeps the status and drops the movement: the working segment
     rests at full opacity instead of pulsing, and every state change becomes a
     plain colour change. */
  .dsah-seg { transition-duration: 1ms; }
  .dsah-seg.is-running { animation: none; opacity: 1; }
}
.dsah-scroll {
  flex: 1 1 auto; overflow: auto; padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 14px;
  opacity: 1; transition: opacity 180ms var(--dsah-ease-out);
  @starting-style { opacity: 0; }
}
.dsah-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.dsah-title { margin: 0; font-size: var(--dsah-fs-title); font-weight: 600; line-height: var(--dsah-lh-small); letter-spacing: -.006em; }
.dsah-sub { font-size: var(--dsah-fs-small); line-height: var(--dsah-lh-body); color: var(--dsw-alias-label-tertiary); max-width: 74ch; }
.dsah-cap { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); letter-spacing: .012em; color: var(--dsw-alias-label-caption); }
.dsah-label { font-size: var(--dsah-fs-cap); color: var(--dsw-alias-label-caption); letter-spacing: .012em; }
.dsah-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsah-spacer { flex: 1 1 auto; }
.dsah-col { display: flex; flex-direction: column; gap: 10px; }
.dsah-note { display: inline-flex; gap: 6px; align-items: center; }
.dsah-card {
  display: flex; flex-direction: column; gap: 10px; padding: 14px 16px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
/* One column on a narrow viewport, the lanes beside the feed on a wide one, so
   the board never needs a horizontal scrollbar. */
.dsah-board { display: grid; gap: 14px; align-items: start; grid-template-columns: minmax(0, 1fr); }
.dsah-lanes { display: grid; gap: 12px; align-items: start; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.dsah-lane {
  display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 14px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
  opacity: 1; transition: box-shadow 160ms var(--dsah-ease-out);
  @starting-style { opacity: 0; }
}
/* The lane head is one disclosure target: a role, a tab stop and the button keys
   make the whole surface clickable without a nested control per field. */
.dsah-lane-head {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0;
  margin: -4px -6px 0; padding: 4px 6px; border-radius: var(--dsw-radius-sm);
  cursor: pointer; border: none; background: none; color: inherit; font: inherit; text-align: left;
}
.dsah-lane-head:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.dsah-lane-name { font-size: var(--dsah-fs-small); font-weight: 600; line-height: var(--dsah-lh-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsah-lane-role { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 22ch; }
.dsah-lane-stats { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: var(--dsah-fs-cap); color: var(--dsw-alias-label-caption); }
.dsah-task { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
/* The output tail is plain text: monospace, pre-wrapped, and its own scroll
   container so a long tail never stretches the lane or the page. */
.dsah-out {
  margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base);
  border-radius: var(--dsw-radius-sm); box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
/* In-flight tokens: same monospace flow as the committed tail, but marked as
   not-yet-settled so a reader can tell the difference at a glance. */
.dsah-live {
  color: var(--dsw-alias-label-primary);
  background: color-mix(in srgb, currentColor 7%, transparent);
  border-radius: var(--dsw-radius-xs);
}
.dsah-fields { display: grid; gap: 8px; }
.dsah-fields-row { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.dsah-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 180px; }
.dsah-area {
  width: 100%; resize: vertical; font: inherit; font-size: var(--dsah-fs-small); line-height: var(--dsah-lh-small);
  padding: 8px 10px; color: inherit; border: none; background: var(--dsw-alias-bg-base);
  border-radius: var(--dsw-radius-sm); box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
.dsah-area:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 1px; }
.dsah-row-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsah-powers, .dsah-models { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dsah-danger { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); color: var(--dsw-alias-state-error-primary); }
.dsah-ok { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); color: var(--dsw-alias-state-success-primary); }
.dsah-warn { font-size: var(--dsah-fs-cap); line-height: var(--dsah-lh-small); color: var(--dsw-alias-state-warn-primary); }
.dsah-empty { font-size: var(--dsah-fs-small); line-height: var(--dsah-lh-body); color: var(--dsw-alias-label-caption); padding: 8px 2px; }
.dsah-steer { display: flex; flex-direction: column; gap: 6px; padding: 8px 0 0; }
.dsah-feed {
  display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 14px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
.dsah-feed-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow: auto; padding-right: 2px; }
/* The harness's own team state, read through the Host half: roster chips plus the
   durable task board. It sits above the free-text feed because a task is a plan
   and the feed is a log — the plan reads first. */
.dsah-team { display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; border-radius: var(--dsw-radius-sm); background: color-mix(in srgb, currentColor 4%, transparent); }
.dsah-team-row { display: flex; gap: 6px; flex-wrap: wrap; }
.dsah-feed-item { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: var(--dsw-radius-sm); background: color-mix(in srgb, currentColor 3%, transparent); }
.dsah-feed-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsah-feed-text { font-size: var(--dsah-fs-small); line-height: var(--dsah-lh-small); color: var(--dsw-alias-label-secondary); word-break: break-word; }
.dsah-feed-route { font-size: var(--dsah-fs-cap); color: var(--dsw-alias-label-caption); }
@media (min-width: 1100px) {
  .dsah-board { grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); align-items: start; }
}
@media (hover: hover) and (pointer: fine) {
  .dsah-lane-head:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .dsah-lane, .dsah-scroll { transition-duration: 1ms; }
}
`)
    }

    /* ------------------------------------------------------------------ *
     * Small shared pieces
     * ------------------------------------------------------------------ */

    /** An icon-only action that keeps the shell's `Button` visuals. */
    function IconButton({ label, icon, onClick, disabled }) {
      return h(Button, {
        size: 'sm', icon, title: label, 'aria-label': label, disabled: disabled === true, onClick,
      })
    }

    /** The connection chip: live over SSE, polling as a fallback, or reconnecting. */
    function ConnectionChip({ status, retryMs, t }) {
      if (status === 'open') return h(Tag, { tone: 'success' }, t('online'))
      if (status === 'polling') return h(Tag, { tone: 'info' }, t('polling'))
      const label = status === 'connecting' ? t('connecting') : t('reconnecting')
      const suffix = retryMs > 0 ? ` · ${t('backoff', { s: Math.max(1, Math.round(retryMs / 1000)) })}` : ''
      return h(Tag, { tone: 'warning' }, `${label}${suffix}`)
    }

    /** The status badge of one agent: the dot carries the colour, the tag the word. */
    function StatusBadge({ status, t }) {
      return h('span', { className: 'dsah-note' },
        h(StateDot, { state: statusDot(status), appearance: 'dot' }),
        h(Tag, { tone: statusTone(status) }, statusLabel(status, t)),
      )
    }

    /**
     * One model picker: provider first, then that provider's models, then the
     * reasoning effort.
     *
     * The two levels are chips rather than a native `<select>` because the shell
     * has no select primitive, and a native control would not carry the panel's
     * typography or theming.
     */
    function ModelPicker({ value, entries, loading, onChange, t }) {
      const providers = []
      const seen = new Set()
      for (const entry of entries) {
        if (seen.has(entry.provider)) continue
        seen.add(entry.provider)
        providers.push(entry)
      }
      if (loading === true) {
        return h('div', { className: 'dsah-bar' },
          h(IconLoadingOutlineMedium, { size: 14 }), h('span', { className: 'dsah-cap' }, t('loadingModels')))
      }
      if (providers.length === 0) return h('div', { className: 'dsah-danger' }, t('noModels'))
      const active = value?.provider ?? ''
      const models = entries.filter(entry => entry.provider === active && entry.empty !== true)
      return h('div', { className: 'dsah-fields' },
        h('div', { className: 'dsah-models' },
          h('span', { className: 'dsah-label' }, t('provider')),
          ...providers.map(entry => h(Pill, {
            key: entry.provider, active: active === entry.provider, title: entry.providerName,
            // Switching provider clears the model: keeping the old id would send
            // a route the new provider does not serve.
            onClick: () => { onChange({ provider: entry.provider, model: '', reasoningEffort: value?.reasoningEffort ?? '' }) },
          }, entry.providerName)),
        ),
        active === ''
          ? h('div', { className: 'dsah-cap' }, t('pickModel'))
          : h('div', { className: 'dsah-models' },
              h('span', { className: 'dsah-label' }, t('model')),
              models.length === 0
                ? h('span', { className: 'dsah-danger' }, t('noModels'))
                : models.map(entry => h(Pill, {
                    key: entry.key, active: value?.model === entry.model,
                    onClick: () => { onChange({ provider: entry.provider, model: entry.model ?? '', reasoningEffort: value?.reasoningEffort ?? '' }) },
                  }, entry.modelName)),
            ),
        active === '' ? null : h('div', { className: 'dsah-models' },
          h('span', { className: 'dsah-label' }, t('effort')),
          ...EFFORTS.map(effort => h(Pill, {
            key: effort === '' ? 'default' : effort, active: (value?.reasoningEffort ?? '') === effort,
            onClick: () => { onChange({ ...value, reasoningEffort: effort }) },
          }, effort === '' ? t('effortDefault') : effort)),
        ),
      )
    }

    /** One editable plan row. */
    function DraftRow({
      row, index, count, error, entries, loading, open, t,
      onToggle, onChange, onMove, onDuplicate, onRemove,
    }) {
      const key = identityOf(row)
      const set = (patch) => { onChange(key, patch) }
      const modelLabel = row.model.provider === '' || row.model.model === ''
        ? t('pickModel') : `${row.model.provider}/${row.model.model}`
      const powers = []
      if (row.powers.write === true) powers.push(t('powerWrite'))
      if (row.powers.shell === true) powers.push(t('powerShell'))
      if (row.powers.message === true) powers.push(t('powerMessage'))
      return h('div', { className: 'dsah-card' },
        h('div', { className: 'dsah-row-head' },
          h('span', { className: 'dsah-cap' }, `#${String(index + 1)}`),
          h(Input, {
            value: row.name, placeholder: t('name'), 'aria-label': t('name'), style: { width: '160px' },
            onChange: (event) => { set({ name: event.target.value }) },
          }),
          h(Input, {
            value: row.role, placeholder: t('role'), 'aria-label': t('role'), style: { width: '180px' },
            onChange: (event) => { set({ role: event.target.value }) },
          }),
          h(Tag, { tone: row.model.model === '' ? 'warning' : 'outline' }, modelLabel),
          error === undefined ? null : h(Tag, { tone: 'danger' }, t(error, { n: MAX_AGENTS })),
          h('span', { className: 'dsah-spacer' }),
          h(IconButton, { label: t('moveUp'), icon: h(IconChevronUpOutlineMedium, null), disabled: index === 0, onClick: () => { onMove(key, -1) } }),
          h(IconButton, { label: t('moveDown'), icon: h(IconChevronDownOutlineMedium, null), disabled: index === count - 1, onClick: () => { onMove(key, 1) } }),
          h(IconButton, { label: t('duplicate'), icon: h(IconCopyOutlineMedium, null), onClick: () => { onDuplicate(key) } }),
          h(IconButton, { label: t('remove'), icon: h(IconTrashOutlineMedium, null), onClick: () => { onRemove(key) } }),
        ),
        h('div', { className: 'dsah-field' },
          h('span', { className: 'dsah-label' }, t('subTask')),
          h('textarea', {
            className: 'dsah-area', rows: 2, value: row.task, placeholder: t('subTask'), 'aria-label': t('subTask'),
            onChange: (event) => { set({ task: event.target.value }) },
          }),
        ),
        h('div', { className: 'dsah-fields-row' },
          h('div', { className: 'dsah-field' },
            h('span', { className: 'dsah-label' }, t('files')),
            h(Input, {
              value: Array.isArray(row.files) ? row.files.join(', ') : '',
              placeholder: t('filesPlaceholder'), 'aria-label': t('files'),
              // The field is a comma-separated declaration, and the stored array
              // stays the single source of truth for the launch body.
              onChange: (event) => {
                set({ files: event.target.value.split(',').map(part => part.trim()).filter(part => part !== '') })
              },
            }),
          ),
        ),
        h(DisclosureRow, {
          icon: h(IconAgentPresetOutlineMedium, null),
          title: `${t('advanced')} · ${modelLabel} · ${powers.join(' / ')}`,
          open: open === true, expandable: true, expandOnRowClick: true,
          onToggle: () => { onToggle(key) },
        },
          h('div', { className: 'dsah-fields' },
            h(ModelPicker, { value: row.model, entries, loading, t, onChange: (next) => { set({ model: next }) } }),
            h('div', { className: 'dsah-powers' },
              // Reading is the floor, so it is shown ticked and disabled rather
              // than hidden: the reader should see that it is not optional.
              h(Checkbox, { checked: true, disabled: true, label: t('powerRead'), title: t('readAlways'), onChange: () => {} }),
              h(Checkbox, { checked: row.powers.write === true, label: t('powerWrite'), onChange: (next) => { set({ powers: { ...row.powers, write: next } }) } }),
              h(Checkbox, { checked: row.powers.shell === true, label: t('powerShell'), onChange: (next) => { set({ powers: { ...row.powers, shell: next } }) } }),
              h(Checkbox, { checked: row.powers.message === true, label: t('powerMessage'), onChange: (next) => { set({ powers: { ...row.powers, message: next } }) } }),
            ),
          ),
        ),
      )
    }

    /**
     * One agent lane: identity and status in the head, the current action, the plain-text output tail, and
     * the three things a human can do to a running agent.
     */
    function AgentLane({ card, now, open, busy, onToggle, onAction, onSteer, readonly, t }) {
      const status = String(card?.status ?? '')
      const steerable = status !== 'draft'
      const outputRef = React.useRef(null)
      // Whether the reader is still following the tail. A ref, not state: it
      // changes on every scroll event and must not re-render the lane.
      const pinned = React.useRef(true)
      const output = typeof card?.output === 'string' ? card.output : ''
      const [steerOpen, setSteerOpen] = React.useState(false)
      const [steerText, setSteerText] = React.useState('')
      const [delivery, setDelivery] = React.useState('queue')
      const [showTail, setShowTail] = React.useState(false)

      React.useEffect(() => {
        const node = outputRef.current
        if (node === null || pinned.current !== true) return
        node.scrollTop = node.scrollHeight
      }, [output])

      const onScroll = () => {
        const node = outputRef.current
        if (node === null) return
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PIN_SLACK_PX
        // The jump-back control is the one thing that must re-render on a
        // reversal, so it is state while the pin itself stays a ref.
        setShowTail(pinned.current !== true)
      }
      const jumpToTail = () => {
        pinned.current = true
        setShowTail(false)
        const node = outputRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }
      const send = () => {
        const text = steerText.trim()
        if (text === '') return
        onSteer(card, text, delivery)
        setSteerText('')
        setSteerOpen(false)
      }
      // A card that never started has no start time to count from, so elapsed
      // reads "not started" rather than counting from `createdAt` — the queue
      // wait is not runtime.
      const startedAt = Number.isFinite(card?.startedAt) && card.startedAt > 0 ? card.startedAt : null
      const endedAt = Number.isFinite(card?.endedAt) ? card.endedAt : null
      const elapsed = startedAt === null ? null : formatElapsed((endedAt ?? now) - startedAt)
      const usage = card?.usage ?? {}
      const files = Array.isArray(card?.files) ? card.files : []
      // In-flight assistant text, streamed token by token from the Host. It is
      // deliberately separate from `output`: committed steps land there, this is
      // the sentence being written right now, and only it may look "live".
      const live = card?.live === undefined || card.live === null ? '' : String(card.live)
      const action = (op) => () => { onAction(op, card) }
      return h('div', { className: 'dsah-lane' },
        h('div', {
          className: 'dsah-lane-head',
          // The head is a control, so it needs a role, a tab stop, and the keys a
          // button answers to; `aria-pressed` carries the expand state.
          role: 'button', tabIndex: 0, 'aria-pressed': open === true,
          'aria-label': `${String(card?.name ?? '')} ${statusLabel(status, t)}`,
          onClick: () => { onToggle(identityOf(card)) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onToggle(identityOf(card))
          },
        },
          h(StateDot, { state: statusDot(status), appearance: 'dot' }),
          h('span', { className: 'dsah-lane-name' }, String(card?.name ?? '')),
          card?.role === undefined || card.role === '' ? null : h('span', { className: 'dsah-lane-role' }, String(card.role)),
          h('span', { className: 'dsah-spacer' }),
          h(Tag, { tone: statusTone(status) }, statusLabel(status, t)),
        ),
        h('div', { className: 'dsah-lane-stats' },
          h(Tag, { tone: 'quiet' }, `${String(card?.model?.provider ?? '')}/${String(card?.model?.model ?? '')}`),
          card?.model?.reasoningEffort ? h(Tag, { tone: 'quiet' }, String(card.model.reasoningEffort)) : null,
          h('span', { className: 'dsah-note' }, h(IconClockOutlineMedium, { size: 12 }),
            `${t('elapsed')} ${elapsed === null ? t('elapsedNotStarted') : elapsed}`),
          h('span', null, `${t('tokens')} ${formatTokens(Number(usage.input ?? 0) + Number(usage.output ?? 0))}`),
          Number(card?.unread ?? 0) > 0 ? h(Tag, { tone: 'info' }, `${String(card.unread)} ${t('unread')}`) : null,
        ),
        h('div', { className: 'dsah-lane-stats' },
          h('span', null, `${t('activity')}：`),
          h('span', { className: 'dsah-task' },
            card?.activity === undefined || card.activity === '' ? t('activityIdle') : String(card.activity)),
        ),
        open !== true ? null : h('div', { className: 'dsah-fields' },
          h('div', { className: 'dsah-field' },
            h('span', { className: 'dsah-label' }, t('laneTask')),
            h('div', { className: 'dsah-task' }, String(card?.task ?? '')),
          ),
          files.length === 0 ? null : h('div', { className: 'dsah-field' },
            h('span', { className: 'dsah-label' }, t('laneScope')),
            h('div', { className: 'dsah-bar' }, ...files.map(file => h(Tag, { key: file, tone: 'outline' }, file))),
          ),
          h('div', { className: 'dsah-field' },
            h('div', { className: 'dsah-bar' },
              h('span', { className: 'dsah-label' }, t('output')),
              h('span', { className: 'dsah-spacer' }),
              showTail ? h(Button, { size: 'sm', onClick: jumpToTail }, t('follow')) : null,
            ),
            output === '' && live === ''
              ? h('div', { className: 'dsah-empty' }, t('outputEmpty'))
              : h('pre', { className: 'dsah-out', ref: outputRef, onScroll, tabIndex: 0 },
                  output,
                  live === '' ? null : h('span', { className: 'dsah-live' }, live)),
          ),
          h('div', { className: 'dsah-lane-stats' },
            h('span', null, t('tokensInOut', {
              in: formatTokens(Number(usage.input ?? 0)), out: formatTokens(Number(usage.output ?? 0)),
            })),
            card?.lastActivityAt ? h('span', null, timeLabel(card.lastActivityAt, now, t)) : null,
          ),
        ),
        card?.error === undefined || card.error === null || card.error === ''
          ? null : h('div', { className: 'dsah-danger' }, String(card.error)),
        steerOpen !== true ? null : h('div', { className: 'dsah-steer' },
          h('textarea', {
            className: 'dsah-area', rows: 2, value: steerText, placeholder: t('steerPlaceholder'),
            'aria-label': t('steer'), autoFocus: true,
            onChange: (event) => { setSteerText(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Escape') { setSteerOpen(false); return }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
            },
          }),
          h('div', { className: 'dsah-bar' },
            h('span', { className: 'dsah-label' }, t('delivery')),
            h(Pill, { active: delivery === 'queue', title: t('deliveryHint'), onClick: () => { setDelivery('queue') } }, t('deliveryQueue')),
            h(Pill, { active: delivery === 'steer', title: t('deliveryHint'), onClick: () => { setDelivery('steer') } }, t('deliverySteer')),
            h('span', { className: 'dsah-spacer' }),
            h(Button, { size: 'sm', variant: 'primary', disabled: busy || steerText.trim() === '', onClick: send }, t('steerSend')),
            h(Button, { size: 'sm', onClick: () => { setSteerOpen(false); setSteerText('') } }, t('steerCancel')),
          ),
        ),
        // The conversation's own lane has no action bar: the three controls steer,
        // wake and interrupt *dispatched* agents, and none of them means anything
        // for the agent you are already talking to. "Interrupt yourself" is not an
        // action a board should offer, so the row is replaced rather than disabled.
        readonly === true
          ? h('div', { className: 'dsah-bar' }, h('span', { className: 'dsah-cap' }, t('leadNote')))
          : h('div', { className: 'dsah-bar' },
              h(Button, {
                size: 'sm', icon: h(IconPaperPlaneOutlineMedium, null), disabled: steerable !== true || busy,
                title: steerable === true ? t('steer') : t('unavailableDraft'),
                onClick: () => { setSteerOpen(true) },
              }, t('steer')),
              h(Button, {
                size: 'sm', icon: h(IconSparkleMedium, null), disabled: steerable !== true || busy,
                title: steerable === true ? t('wake') : t('unavailableDraft'), onClick: action('agent.wake'),
              }, t('wake')),
              h(Button, {
                size: 'sm', icon: h(IconStopFillMedium, null), disabled: steerable !== true || busy,
                title: steerable === true ? t('interrupt') : t('unavailableDraft'), onClick: action('interrupt'),
              }, t('interrupt')),
            ),
      )
    }

    /** One feed row: who said it, to whom, and how long ago. */
    function FeedRow({ item, now, t }) {
      const kind = String(item?.kind ?? 'system')
      const tone = {
        plan: 'info', progress: 'outline', message: 'success',
        handoff: 'warning', human: 'solid', system: 'neutral',
      }[kind] ?? 'neutral'
      const key = `kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
      const to = item?.to === '*' || item?.to === null || item?.to === undefined
        ? t('feedAll') : String(item?.toName ?? item?.to ?? '')
      return h('div', { className: 'dsah-feed-item' },
        h('div', { className: 'dsah-feed-meta' },
          h(Tag, { tone }, t(key)),
          h('span', { className: 'dsah-feed-route' }, `${String(item?.fromName ?? item?.from ?? '')} → ${to}`),
          h('span', { className: 'dsah-spacer' }),
          h('span', { className: 'dsah-cap' }, timeLabel(Number(item?.time ?? now), now, t)),
        ),
        h('div', { className: 'dsah-feed-text' }, String(item?.text ?? '')),
      )
    }

    /**
     * The broadcast box: one message to the whole team, which is the common case
     * and therefore the default target.
     */
    function BroadcastBox({ busy, onSend, t }) {
      const [text, setText] = React.useState('')
      const send = () => {
        const trimmed = text.trim()
        if (trimmed === '') return
        onSend(trimmed)
        setText('')
      }
      return h('div', { className: 'dsah-steer' },
        h('textarea', {
          className: 'dsah-area', rows: 2, value: text, placeholder: t('broadcastPlaceholder'),
          'aria-label': t('broadcast'),
          onChange: (event) => { setText(event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send() },
        }),
        h('div', { className: 'dsah-bar' },
          h(Button, {
            size: 'sm', variant: 'primary', icon: h(IconPaperPlaneOutlineMedium, null),
            disabled: busy || text.trim() === '', onClick: send,
          }, t('broadcast')),
          h('span', { className: 'dsah-cap' }, t('broadcastToAll')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Live wiring
     * ------------------------------------------------------------------ */

    /**
     * Follow one board over SSE, reconnecting with exponential backoff.
     *
     * Three details are load-bearing:
     *
     * 1. **A retry is triggered by the error event and the browser's own
     *    reconnect is refused** by closing the source. That is the only way to
     *    impose this backoff: `EventSource` retries on its own schedule, and two
     *    competing reconnects would double every frame.
     * 2. **The stream URL carries no marker header**, because `EventSource`
     *    cannot send headers. The Host half's stream endpoint deliberately does
     *    not require it; every write still goes through `hostCall`.
     * 3. **A re-opened stream refetches `op=state`.** Reconnecting only promises
     *    a *fresh* snapshot from the moment of re-subscribe, so a board that
     *    changed while disconnected would otherwise stay stale until the next
     *    mutation.
     */
    function streamLoop(sessionId, onState, onEvent, onStatus) {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof EventSource !== 'function') {
        onStatus(typeof sessionId === 'string' && sessionId !== '' ? 'error' : 'idle', 0)
        return () => {}
      }
      let source = null
      let timer = null
      let poll = null
      let failures = 0
      let delay = RETRY_BASE_MS
      let closed = false
      const base = typeof window !== 'undefined' && window.location !== undefined ? window.location.origin : 'http://localhost'
      const url = new URL(ENDPOINT, base)
      url.searchParams.set('op', 'stream')
      url.searchParams.set('sessionId', sessionId)

      /** Re-read the whole board; used by the first read and after a reconnect. */
      const catchUp = () => {
        hostCall('state', { sessionId }).then(next => { if (!closed) onState(next) }).catch(() => {})
      }
      /** Stop the fallback poller; called as soon as the stream is healthy again. */
      const stopPolling = () => {
        if (poll === null) return
        window.clearInterval(poll)
        poll = null
      }
      /**
       * Keep the board current without a stream.
       *
       * Entered only after repeated failures and left again the moment an
       * EventSource opens: the retry chain keeps running underneath, so a
       * recovered stream takes over on its own without the panel being reloaded.
       */
      const startPolling = () => {
        if (poll !== null || closed) return
        onStatus('polling', 0)
        poll = window.setInterval(() => { catchUp() }, POLL_INTERVAL_MS)
      }
      const open = (isRetry) => {
        if (closed) return
        onStatus(isRetry ? 'reconnecting' : 'connecting', 0)
        const next = new EventSource(url.toString())
        source = next
        next.onopen = () => {
          if (closed) return
          delay = RETRY_BASE_MS
          failures = 0
          stopPolling()
          onStatus('open', 0)
          // Only a retry needs the catch-up read: a first connection is followed
          // immediately by the Host's own snapshot.
          if (isRetry) catchUp()
        }
        next.onerror = () => {
          if (closed) return
          next.close()
          source = null
          failures += 1
          if (failures >= POLL_AFTER_FAILURES) startPolling()
          // Rounded because `setTimeout` takes whole milliseconds, and a
          // fractional delay would make the retry schedule drift.
          const wait = Math.round(Math.min(delay, RETRY_MAX_MS))
          onStatus('reconnecting', wait)
          delay = Math.min(delay * RETRY_FACTOR, RETRY_MAX_MS)
          timer = window.setTimeout(() => { open(true) }, wait)
        }
        for (const name of ['snapshot', 'agent', 'feed', 'board', 'heartbeat']) {
          next.addEventListener(name, (event) => {
            let data
            try {
              data = JSON.parse(event.data)
            } catch (_error) {
              // A truncated frame is not worth tearing the stream down for: the
              // reconnect path refetches the full state anyway.
              return
            }
            onEvent(name, data)
          })
        }
      }
      open(false)
      return () => {
        closed = true
        stopPolling()
        if (timer !== null) window.clearTimeout(timer)
        if (source !== null) source.close()
      }
    }

    /** One live board: state, stream, and the mutating verbs. */
    function useBoard(sessionId) {
      const [state, setState] = React.useState(() => emptyState(sessionId ?? ''))
      const [status, setStatus] = React.useState('connecting')
      const [retryMs, setRetryMs] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      // Frame handlers read the latest state through a ref instead of being
      // re-created (which would re-open the stream) on every single frame.
      const stateRef = React.useRef(state)
      stateRef.current = state
      const seed = React.useCallback(
        (next) => { setState(applyStreamEvent(emptyState(sessionId), 'snapshot', next)) },
        [sessionId],
      )

      React.useEffect(() => {
        let live = true
        setStatus('connecting')
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState(emptyState(''))
          return () => { live = false }
        }
        hostCall('state', { sessionId })
          .then((next) => { if (live) seed(next) })
          .catch((failure) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
        const dispose = streamLoop(
          sessionId,
          (next) => { if (live) seed(next) },
          (event, data) => {
            if (!live) return
            const previous = stateRef.current
            const merged = applyStreamEvent(previous, event, data, Date.now())
            // React bails out on an identical reference, so a heartbeat with an
            // unchanged clock costs no render.
            if (merged !== previous) setState(merged)
          },
          (nextStatus, waitMs) => {
            if (!live) return
            setStatus(nextStatus)
            setRetryMs(waitMs)
          },
        )
        return () => {
          live = false
          dispose()
        }
      }, [sessionId, seed])

      /** Run one write, then surface its notice or its failure. */
      const run = React.useCallback(async (op, body, success) => {
        setBusy(true)
        try {
          const result = await hostCall(op, undefined, { sessionId, ...body })
          setError(null)
          setNotice(success ?? null)
          return result ?? {}
        } catch (failure) {
          setNotice(null)
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      /** Re-read the whole board on demand. */
      const refresh = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          seed(await hostCall('state', { sessionId }))
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId, seed])

      return { state, status, retryMs, busy, error, notice, setError, setNotice, run, refresh }
    }

    /**
     * Resolve which conversation's board a root-scope panel shows.
     *
     * A root-scope `main` panel receives no session, so the current conversation
     * is read the same way the shell reads it for the window title: the session
     * the main view actually retains. An explicit pick wins over that, which is
     * what makes the hub usable while another panel is in front.
     */
    /** The three things a board needs out of a session list snapshot. */
    function selectSessions(snapshot) {
      const rows = Object.values(snapshot?.byId ?? {})
      const main = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)
      return {
        byId: snapshot?.byId ?? {},
        mainId: main?.id === undefined ? null : String(main.id),
        recent: [...rows].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
          .slice(0, 8).map(row => String(row.id)),
      }
    }

    /**
     * Subscribe to a snapshot store without the shell's React hook.
     *
     * The shell's own `useSessions` lives in a client package that an out-of-tree
     * plugin cannot require, so the equivalent is read from the session list
     * service when the deployment exposes one. Everything is feature-detected:
     * an observable that is not shaped as expected yields null and the caller
     * falls through to its "no session" path instead of throwing mid-render.
     * @param {Record<string, any>|null} observable - Snapshot store, or null.
     * @returns {Record<string, any>|null} Latest snapshot, or null.
     */
    function useObservable(observable) {
      const [value, setValue] = React.useState(() => (observable === null ? null : observable.getSnapshot()))
      React.useEffect(() => {
        if (observable === null) {
          setValue(null)
          return () => {}
        }
        let live = true
        const sync = () => { if (live) setValue(observable.getSnapshot()) }
        sync()
        const off = observable.subscribe(sync)
        return () => {
          live = false
          if (typeof off === 'function') off()
        }
      }, [observable])
      return value
    }

    /**
     * Resolve which conversation's board a root-scope panel shows.
     *
     * A root-scope `main` panel receives no session, so the current conversation
     * is read the same way the shell reads it for the window title: the session
     * the main view actually retains. An explicit pick wins over that, which is
     * what makes the hub usable while another panel is in front.
     *
     * Two sources are tried because neither is guaranteed: the shell's hook when
     * the slot supplies it, and the session list service when the deployment
     * composes one. With neither, the panel still renders — it explains that a
     * board is bound to a conversation rather than guessing one. Both hooks are
     * called on every render so their order never changes.
     * @param {unknown} useSessions - Shell hook from slot props, when present.
     * @param {unknown} sessionList - Session list service, when present.
     * @returns {Record<string, any>} Resolution result.
     */
    function useCurrentSession(useSessions, sessionList) {
      const [picked, setPicked] = React.useState(null)
      const fromShell = typeof useSessions === 'function' ? useSessions(selectSessions) : null
      const snapshot = useObservable(
        sessionList !== null && sessionList !== undefined
          && typeof sessionList.getSnapshot === 'function' && typeof sessionList.subscribe === 'function'
          ? sessionList
          : null,
      )
      const list = fromShell ?? (snapshot === null ? null : selectSessions(snapshot))
      if (list === null) return { id: undefined, recent: [], byId: {}, pick: setPicked, bound: false }
      const id = picked ?? list.mainId ?? list.recent[0] ?? null
      return {
        id: id === null ? undefined : String(id),
        recent: list.recent,
        byId: list.byId,
        pick: setPicked,
        bound: true,
      }
    }

    /** The catalog of providers and models, fetched once per mount. */
    function useModelCatalog() {
      const [catalog, setCatalog] = React.useState(null)
      React.useEffect(() => {
        let live = true
        hostCall('models')
          .then((next) => { if (live) setCatalog(next ?? { providers: [] }) })
          // A failed catalogue is an empty one: the panel still works, it just
          // cannot offer models until the Host half answers.
          .catch(() => { if (live) setCatalog({ providers: [] }) })
        return () => { live = false }
      }, [])
      return { entries: modelEntries(catalog), loading: catalog === null }
    }

    /**
     * A locally ticking clock, so elapsed time advances once per second without
     * one request per second per lane.
     */
    function useSecondTick() {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { window.clearInterval(timer) }
      }, [])
      return now
    }

    /* ------------------------------------------------------------------ *
     * Board surfaces
     * ------------------------------------------------------------------ */

    /**
     * The board itself, shared by the panel and the conversation view.
     *
     * `sessionId` is resolved by the caller: the root panel derives it from the
     * session list, and the conversation view is handed it by the shell.
     */
    /**
     * The harness's own Agent Teams state, rendered inside this board.
     *
     * Both features answer "several agents, one board", so they are presented as
     * one: the team's roster and its durable task board appear here beside the
     * hub's own lanes and feed.
     *
     * The tasks matter most. They are the **durable** half — written to the Lead's
     * session log — so unlike this board's in-memory projection they survive a
     * restart, and they are the same board the native Team panel and the
     * `team_task_*` tools read and write. Showing them here is what makes "the
     * plan" one object instead of two.
     * @param {Record<string, any>} props - Team snapshot plus the translate function.
     * @returns {unknown} React element.
     */
    function TeamPanel({ team, t }) {
      if (team === null || team === undefined || team.available !== true) return null
      const members = Array.isArray(team.members) ? team.members : []
      const tasks = Array.isArray(team.tasks) ? team.tasks : []
      const open = tasks.filter(task => task.status !== 'completed' && task.status !== 'deleted')
      return h('div', { className: 'dsah-team' },
        h('div', { className: 'dsah-bar' },
          h('span', { className: 'dsah-label' }, t('teamBoard')),
          h('span', { className: 'dsah-cap' }, t('teamCounts', { a: members.length, b: open.length })),
        ),
        typeof team.error === 'string' && team.error !== ''
          ? h('div', { className: 'dsah-empty' }, team.error)
          : null,
        typeof team.warning === 'string' && team.warning !== ''
          ? h('div', { className: 'dsah-empty' }, team.warning)
          : null,
        members.length === 0 ? null : h('div', { className: 'dsah-team-row' },
          ...members.map(member => h(Tag, {
            key: String(member.id),
            tone: member.role === 'lead' ? 'info'
              : member.status === 'running' ? 'success'
                : member.status === 'failed' ? 'danger' : 'outline',
          }, `${String(member.name)}${member.model === undefined ? '' : ` · ${String(member.model)}`}`)),
        ),
        open.length === 0
          ? h('div', { className: 'dsah-empty' }, t('teamNoTasks'))
          : h('div', { className: 'dsah-feed-list' },
              ...open.map(task => h('div', { className: 'dsah-feed-item', key: String(task.id) },
                h('div', { className: 'dsah-feed-meta' },
                  h(Tag, { tone: task.status === 'in_progress' ? 'info' : 'outline' },
                    t(task.status === 'in_progress' ? 'taskActive' : 'taskPending')),
                  h('span', { className: 'dsah-feed-route' }, String(task.id)),
                  task.ownerName === undefined
                    ? null
                    : h('span', { className: 'dsah-feed-route' }, `→ ${String(task.ownerName)}`),
                  Array.isArray(task.blockedBy) && task.blockedBy.length > 0
                    ? h('span', { className: 'dsah-feed-route' }, t('taskBlocked', { ids: task.blockedBy.join('、') }))
                    : null,
                ),
                h('div', { className: 'dsah-feed-text' }, String(task.subject)),
                Array.isArray(task.writeScopes) && task.writeScopes.length > 0
                  ? h('div', { className: 'dsah-feed-route' }, task.writeScopes.join('、'))
                  : null,
              )),
            ),
      )
    }

    function BoardBody({ sessionId, name, picker, t }) {
      const board = useBoard(sessionId)
      const catalog = useModelCatalog()
      const now = useSecondTick()
      const [rows, setRows] = React.useState(null)
      const [objective, setObjective] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [openRows, setOpenRows] = React.useState({})
      const state = board.state
      const phase = phaseOf(state)
      const live = phase === 'running' || phase === 'done'
      // A running board opens in the 运行态; `editing` is the way back to the
      // plan, and a plan that is still all-draft is always the 编排态.
      const planning = live !== true || editing === true
      const derived = planCards(state).map((card, index) => draftRowFromCard(card, index))
      const plan = rows ?? derived
      const validation = validateDraft(plan)
      const mutators = planMutators(setRows, derived)

      // The objective box lives outside the row list, so it is re-seeded when the
      // *board identity* changes and never when a frame merely refreshes it —
      // otherwise a frame would type over whatever the reader is writing.
      const seedRef = React.useRef(null)
      React.useEffect(() => {
        const key = String(sessionId ?? '')
        const switched = seedRef.current !== key
        seedRef.current = key
        if (switched) {
          setObjective(state.objective)
          setRows(null)
          setEditing(false)
          return
        }
        if (state.objective !== '' && objective === '') setObjective(state.objective)
      }, [sessionId, state.objective, objective])

      const toggleRow = (key) => { setOpenRows(current => ({ ...current, [key]: current[key] !== true })) }
      /** Ask the coordinator model to split the objective into rows. */
      const split = async () => {
        if (objective.trim() === '') {
          board.setError(t('needObjective'))
          return
        }
        const result = await board.run('draft', { objective: objective.trim() }, null)
        if (result === null) return
        const drafted = Array.isArray(result.draft?.agents) ? result.draft.agents : []
        setRows(drafted.map((card, index) => draftRowFromCard(card, index)))
        if (typeof result.draft?.objective === 'string') setObjective(result.draft.objective)
      }
      /** Start every row. */
      const launch = async () => {
        const report = validateDraft(plan)
        if (report.ok !== true) {
          board.setError(t(String(Object.values(report.errors)[0]), { n: MAX_AGENTS }))
          return
        }
        const result = await board.run('launch', launchPayload(objective, plan), null)
        if (result === null) return
        setRows(null)
        setEditing(false)
      }
      const stopAll = async () => {
        const result = await board.run('stopAll', {}, null)
        if (result !== null) board.setNotice(t('stoppedNotice', { n: Number(result.stopped ?? 0) }))
      }
      /** One lane verb; all three share this path because the shape is the same. */
      const laneAction = (op, card) => {
        const agentId = identityOf(card)
        if (agentId === '') return
        void board.run(op, { agentId }, t('accepted'))
      }
      const laneSteer = (card, text, delivery) => {
        void board.run('steer', { agentId: identityOf(card), text, delivery }, t('sent'))
      }

      if (sessionId === undefined) {
        return h('div', { className: 'dsah-scroll' }, h('div', { className: 'dsah-empty' }, t('noSession')))
      }

      const header = h('div', { className: 'dsah-head' },
        h('div', { className: 'dsah-col', style: { gap: '2px', flex: '1 1 320px' } },
          h('h2', { className: 'dsah-title' }, t('title')),
          h('div', { className: 'dsah-sub' }, t('subtitle')),
          h('div', { className: 'dsah-cap' }, t('bindHint', { name: name ?? sessionId })),
        ),
        h('span', { className: 'dsah-spacer' }),
        h(StatusBadge, { status: phase === 'idle' ? 'idle' : phase === 'planned' ? 'draft' : phase, t }),
        h(ConnectionChip, { status: board.status, retryMs: board.retryMs, t }),
        h(Button, {
          size: 'sm', icon: h(IconRefreshOutlineMedium, null), disabled: board.busy,
          onClick: () => { void board.refresh() },
        }, t('refresh')),
        h(Button, {
          size: 'sm', icon: h(IconStopFillMedium, null),
          disabled: board.busy || state.agents.length === 0,
          onClick: () => { void stopAll() },
        }, t('stopAll')),
        picker ?? null,
      )

      const feed = h('div', { className: 'dsah-feed' },
        h('div', { className: 'dsah-bar' },
          h('span', { className: 'dsah-label' }, t('feed')),
          h('span', { className: 'dsah-cap' }, String(state.feed.length)),
        ),
        // The durable half of the integration, in the same column as the feed so
        // the two read as one picture rather than two competing features.
        h(TeamPanel, { team: state.team, t }),
        state.feed.length === 0
          ? h('div', { className: 'dsah-empty' }, t('feedEmpty'))
          : h('div', { className: 'dsah-feed-list' },
              ...state.feed.map((item, index) => h(FeedRow, {
                // Feed ids are server-assigned and stable; the index only backs up
                // a frame that arrived without one.
                key: typeof item?.id === 'string' && item.id !== '' ? item.id : `f${String(index)}`,
                item, now, t,
              })),
            ),
        h(BroadcastBox, { busy: board.busy, t, onSend: (text) => { void board.run('broadcast', { text }, t('sent')) } }),
      )

      const lanes = h('div', { className: 'dsah-lanes' },
        // The lead comes first: the board reads as "this conversation's agent, and
        // the agents it put to work", which is what it is.
        ...(state.lead === null || state.lead === undefined
          ? []
          : [h(AgentLane, {
              key: 'lead', card: state.lead, now, t, busy: false, readonly: true,
              open: openRows.lead === true, onToggle: toggleRow,
              onAction: () => {}, onSteer: () => {},
            })]),
        ...state.agents.map(card => h(AgentLane, {
          key: identityOf(card), card, now, t, busy: board.busy,
          open: openRows[identityOf(card)] === true,
          onToggle: toggleRow, onAction: laneAction, onSteer: laneSteer,
        })),
      )

      const planArea = h('div', { className: 'dsah-col' },
        h('div', { className: 'dsah-card' },
          h('div', { className: 'dsah-field' },
            h('span', { className: 'dsah-label' }, t('objective')),
            h('textarea', {
              className: 'dsah-area', rows: 3, value: objective, placeholder: t('objectivePlaceholder'),
              'aria-label': t('objective'),
              onChange: (event) => { setObjective(event.target.value) },
            }),
          ),
          h('div', { className: 'dsah-bar' },
            h(Button, {
              variant: 'primary',
              icon: catalog.loading === true ? h(IconLoadingOutlineMedium, null) : h(IconSparkleMedium, null),
              disabled: board.busy || catalog.loading === true || state.hasLLM !== true,
              title: state.hasLLM === true ? t('draftHint') : t('noLLM'),
              onClick: () => { void split() },
            }, board.busy ? t('drafting') : t('draft')),
            h(Button, {
              icon: h(IconPlusOutlineMedium, null), disabled: plan.length >= MAX_AGENTS, onClick: mutators.add,
            }, t('addAgent')),
            h('span', { className: 'dsah-spacer' }),
            h('span', { className: 'dsah-cap' }, `${String(plan.length)} / ${String(MAX_AGENTS)}`),
          ),
          state.hasLLM === true ? null : h('div', { className: 'dsah-warn' }, t('noLLM')),
          validation.ok === true || plan.length === 0 ? null : h('div', { className: 'dsah-danger' },
            Object.values(validation.errors)
              .map(code => t(String(code), { n: MAX_AGENTS }))
              .filter((text, index, all) => all.indexOf(text) === index)
              .join('、')),
        ),
        plan.length === 0
          ? h('div', { className: 'dsah-empty' }, t('draftEmpty'))
          : plan.map((row, index) => h(DraftRow, {
              key: identityOf(row), row, index, count: plan.length, t,
              error: validation.errors[identityOf(row)],
              entries: catalog.entries, loading: catalog.loading,
              open: openRows[identityOf(row)] === true,
              onToggle: toggleRow, onChange: mutators.patch, onMove: mutators.move,
              onDuplicate: mutators.duplicate, onRemove: mutators.remove,
            })),
        h('div', { className: 'dsah-bar' },
          h(Button, {
            variant: 'primary', icon: h(IconPlayOutlineMedium, null),
            disabled: board.busy || validation.ok !== true, onClick: () => { void launch() },
          }, t('launchCount', { n: plan.length })),
          h(Button, { disabled: board.busy || rows === null, onClick: () => { setRows(null) } }, t('clear')),
          h('span', { className: 'dsah-cap' }, t('draftHint')),
        ),
      )

      return h('div', { className: 'dsah-scroll' },
        header,
        board.error !== null
          ? h('div', { className: 'dsah-danger' }, board.error)
          : board.notice !== null ? h('div', { className: 'dsah-ok' }, board.notice) : null,
        board.status === 'open' || board.status === 'idle' ? null : h('div', { className: 'dsah-warn' }, t('streamRetry')),
        h('div', { className: 'dsah-board' },
          planning === true ? planArea : h('div', { className: 'dsah-col' },
            h('div', { className: 'dsah-bar' },
              h('span', { className: 'dsah-cap' }, state.objective),
              h('span', { className: 'dsah-spacer' }),
              h(Button, {
                size: 'sm', icon: h(IconPlusOutlineMedium, null), onClick: () => { setEditing(true) },
              }, t('editing')),
            ),
            lanes,
          ),
          feed,
        ),
      )
    }

    /** The 协作台 panel: resolves the conversation, then renders the board. */
    function AgentHubPage(props) {
      const t = props.t
      const session = useCurrentSession(props.useSessions, props.sessionList)
      // The board is a server-side keyed object: this client only needs the
      // session id, the conversation's display name, and a picker when more than
      // one conversation could own a board.
      const picker = session.recent.length <= 1 ? null : h('div', { className: 'dsah-bar' },
        h('span', { className: 'dsah-cap' }, t('sessionPick')),
        ...session.recent.map(id => h(Pill, {
          key: id, active: session.id === id,
          title: String(session.byId[id]?.displayTitle ?? id),
          onClick: () => { session.pick(id) },
        }, String(session.byId[id]?.displayTitle ?? id).slice(0, 16))),
      )
      return h('div', { className: 'dsah' },
        h(StyleSheet),
        h(BoardBody, {
          sessionId: session.id,
          name: session.id === undefined ? undefined : String(session.byId[session.id]?.displayTitle ?? session.id),
          picker,
          t,
        }),
      )
    }

    /**
     * The **协作台** conversation view: the same board, bound to the session the
     * shell hands the view directly, so no session resolution is involved.
     */
    function AgentHubView(props) {
      return h('div', { className: 'dsah' },
        h(StyleSheet),
        h(BoardBody, {
          sessionId: props.sessionId === undefined ? undefined : String(props.sessionId),
          name: undefined,
          picker: null,
          t: props.t,
        }),
      )
    }

    /**
     * One segment's state class.
     *
     * `idle` and `queued` share `is-pending`: an agent that has been published but
     * has not started a turn is not "working" yet, and showing it as such would
     * overstate what the strip knows.
     * @param {Record<string, any>} card - Agent card.
     * @returns {string} `is-pending` | `is-running` | `is-done` | `is-failed`.
     */
    function segmentState(card) {
      const status = card?.status
      if (status === 'error' || status === 'stopped') return 'is-failed'
      if (TERMINAL_STATUSES.includes(status)) return 'is-done'
      if (status === 'running') return 'is-running'
      return 'is-pending'
    }

    /** Sidebar glyph for the panel entry. */
    function HubIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 6.5h4.6v4.6H4zM15.4 6.5H20v4.6h-4.6zM9.7 15.4h4.6V20H9.7z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8.6 8.8h6.8M12 11.1v4.3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin definition
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      // The pure half of this file, exported so it can be exercised without a
      // browser render (and so the merge rules have one single definition).
      helpers: {
        emptyState, applyStreamEvent, mergeAgent, draftFromState, validateDraft,
        newDraftRow, formatElapsed, formatTokens, statusTone, statusLabel, phaseOf, hostCall,
        // Extras the page itself needs; exported for the same reason. The stream
        // loop is here so its backoff schedule can be tested without a browser.
        draftRowFromCard, launchPayload, modelEntries, timeLabel, identityOf,
        appendFeed, statusDot, segmentState, streamLoop, MAX_AGENTS,
      },

      /**
       * Contribute the sidebar entry, the main-column board, the conversation view
       * beside 对话/轨迹, and the composer strip.
       */
      apply(ctx) {
        // The locale service is optional: with it the panel follows the shell's
        // language, without it the built-in dictionary still renders.
        let t = fallbackT()
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en }), 'agent-hub: dictionaries')
          if (typeof locale.bind === 'function') {
            const bound = locale.bind(NS)
            t = (key, params) => bound(key, params)
          }
        }
        // The layout service owns which main panel is in front; the composer
        // strip's only action is selecting this one's key.
        const layout = ctx.get('layout')

        // A board is bound to a conversation, and this slot is root-scoped: the
        // shell passes no session to it. The session list service is therefore
        // read here with an optional lookup and handed to the panel, which falls
        // back to an explanation when neither source exists. `ctx.get` is an
        // optional lookup on the dynamic guard, so an undeclared service is
        // undefined here rather than an error.
        const sessions = ctx.get('sessions')
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ t, sessionList: sessions?.list }),
          }, AgentHubPage)
        })

        // Order 20 places the tab after the shell's own views: chat is 0 and the
        // trajectory is 10.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: PANEL_ID,
          order: 20,
          label: () => t('viewTitle'),
          inject: () => ({ t }),
        }, AgentHubView))

        // Deliberately no `conversation.input.dock` registration. The hub used to
        // advertise itself above the composer with a "run this in parallel" strip
        // and an "open the hub" button; both were removed because the strip made a
        // claim about every message the user typed, and the panel is already one
        // click away in the sidebar. The hub is a tool, not a prompt.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => t('panel'),
        }, HubIcon))
      },
    }
  },
})
