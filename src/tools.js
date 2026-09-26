/**
 * The hub's model-facing tools: open a team, post progress, read the board.
 *
 * The board the humans watch and the board the agents write to are the same
 * board on purpose: a separate machine-to-machine channel would let the UI and
 * the agents disagree about what happened. `hub_post` appends to that feed and,
 * when addressed to a peer, also delivers the text into that peer's inbox, so
 * "tell the others" is one action rather than a post plus a hope.
 *
 * All three tools are registered on the plugin's root context, which means every
 * agent in the deployment can see them. An agent that belongs to no board gets a
 * clear 409-style error from the call rather than a silently dropped message.
 *
 * @module dsh-agent-hub/src/tools
 */

import { messageOf } from './hub.js'

/** Kinds a model may label its own post with. */
const POST_KINDS = ['progress', 'handoff', 'message']

/**
 * Build the `hub_post` definition.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {Record<string, any>} Tool definition.
 */
function hubPostTool(hub) {
  return {
    name: 'hub_post',
    description:
      'Post one short line of progress to the shared board of the agent team you belong to. '
      + 'Use it when you reach a milestone, finish your task, or need something a teammate owns. '
      + 'Pass `to` with a teammate name to deliver the line into that teammate\'s inbox instead of only posting it.',
    // `ctx.tools.register` takes a RAW JSON Schema, not the `defineTool`
    // property-map DSL: the wire contract of every provider requires an
    // object-rooted schema, and a bare property map reaches the model API as
    // `type: null`, which the endpoint rejects with "Invalid schema for
    // function 'hub_post'". Keep `type: 'object'` + `properties` here.
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One or two sentences. Concrete: what you produced, where it is, what you need.' },
        to: { type: 'string', description: 'Teammate name to deliver to, or all/omitted to post to everyone.' },
        kind: { type: 'string', enum: POST_KINDS, description: 'progress (default), handoff (work passed to a peer), or message.' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result) }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      const result = await hub.postFromAgent(sessionId, args ?? {})
      return result.delivered === 0
        ? '已发布到共享进度板（全体可见）。'
        : `已发布，并已投递给 ${result.item.toName}。`
    },
  }
}

/**
 * Build the `hub_read` definition.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {Record<string, any>} Tool definition.
 */
function hubReadTool(hub) {
  return {
    name: 'hub_read',
    description:
      'Read the shared progress board: the team roster, who owns which files, and what everyone has reported so far. '
      + 'Call it before starting work so you do not duplicate a teammate, and again before you finish.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent entries to read (default 25, max 100).' },
        since: { type: 'number', description: 'Only entries at or after this epoch-millisecond timestamp.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result) }],
    },
    execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      return formatBoard(hub.readFor(sessionId, args ?? {}))
    },
  }
}

/**
 * Render a board view as compact text for a model to read.
 * @param {Record<string, any>} view - `Hub.readFor` result.
 * @returns {string} Text.
 */
export function formatBoard(view) {
  const lines = [`目标：${view.objective === '' ? '（未声明）' : view.objective}`]
  lines.push(`你：${view.you.name}${view.you.task === undefined ? '' : ` — ${view.you.task}`}`)
  lines.push('', '队友：')
  for (const member of view.roster) {
    lines.push(`- ${member.name}（${member.status}）${member.role === '' ? '' : ` ${member.role}`}`
      + `${member.files.length === 0 ? '' : ` · 负责 ${member.files.join(', ')}`}`)
  }
  lines.push('', `进度板（最近 ${view.feed.length} 条）：`)
  if (view.feed.length === 0) lines.push('- （还没有人汇报）')
  for (const item of view.feed) {
    const time = new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })
    lines.push(`- [${time}] ${item.from} → ${item.to}：${item.text}`)
  }
  // The harness's own Agent Teams state, rendered in the same answer so an agent
  // never has to know that "the team" and "the board" are two subsystems.
  const team = view.team
  if (team !== undefined && team !== null && team.available === true) {
    if (team.error !== undefined && team.error !== null) {
      lines.push('', `原生团队状态读取失败：${team.error}`)
    } else if (team.readable === true) {
      lines.push('', `原生 Agent Teams：${team.members.length} 个成员、${team.tasks.length} 个任务`)
      for (const member of team.members) {
        lines.push(`- 成员 ${member.name}（${member.status}${member.role === 'lead' ? '，lead' : ''}）`
          + `${member.model === undefined ? '' : ` · ${member.model}`}`)
      }
      for (const task of team.tasks) {
        lines.push(`- [${task.status}] ${task.id} rev${task.revision}：${task.subject}`
          + `${task.ownerName === undefined ? '' : `（负责：${task.ownerName}）`}`
          + `${task.writeScopes.length === 0 ? '' : ` · 范围 ${task.writeScopes.join('、')}`}`
          + `${task.blockedBy.length === 0 ? '' : ` · 依赖 ${task.blockedBy.join('、')}`}`)
      }
    }
    if (typeof team.warning === 'string' && team.warning !== '') lines.push(`- 注意：${team.warning}`)
  }
  return lines.join('\n')
}

/**
 * Build the `hub_launch` definition: the one call that turns "this is worth
 * parallelising" into a running team.
 *
 * It exists because the policy is worthless without it. Before this tool an
 * agent could post to a board and read one, but only a human pressing a button
 * could create one — so a standing instruction like "open a board when the work
 * splits" would have been advice the model had no way to act on.
 *
 * Two shapes, because the coordinator call is a model round trip:
 *
 * - `objective` alone lets the coordinator split it, which is right when the
 *   agent does not already know how the work divides;
 * - `objective` + `agents` skips that call and launches the given roster, which
 *   is what an agent that has already done the thinking wants.
 *
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {Record<string, any>} Tool definition.
 */
function hubLaunchTool(hub) {
  return {
    name: 'hub_launch',
    description:
      'Open this conversation\'s shared board and start a team of agents on one objective — each with its own provider/model and file scope, all reporting to one progress board the user watches live. '
      + 'Call it with only an `objective` and the coordinator model splits the work into roles; pass `agents` to launch a roster you designed yourself. '
      + 'Reach for it when the objective splits into genuinely independent parts, when breadth across modules or options matters, or when a second model\'s judgement is worth having. '
      + 'Do not use it for sequential work, a single-file change, or anything two or three steps will finish: dispatching costs a coordinator call plus every agent\'s own context. '
      + 'After it returns, tell the user who is doing what in one line and get on with your own share.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The single objective the whole team shares, stated once.' },
        count: { type: 'number', description: 'How many agents the coordinator should create (default 4). Ignored when `agents` is given.' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional `provider/model` shortlist (for example ["deepseek-official/deepseek-flash","zai-coding-cn/glm-4.7"]). '
            + 'Rows that name no model are assigned from it in turn, so a team can work across providers without every row repeating a route. '
            + 'Use the routes listed in your system prompt: a route no provider serves fails that row\'s launch rather than being silently replaced.',
        },
        agents: {
          type: 'array',
          description: 'An explicit roster. When present the coordinator is skipped and exactly these are launched.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short display name; a teammate is addressed by this.' },
              role: { type: 'string', description: 'One line describing the role.' },
              task: { type: 'string', description: 'What this agent must produce and how to verify it. Self-contained: it cannot see this conversation.' },
              provider: { type: 'string', description: 'LLM provider id, for example deepseek-official.' },
              model: { type: 'string', description: 'Model id within that provider.' },
              files: { type: 'array', items: { type: 'string' }, description: 'Paths or globs this agent owns. Must not overlap another row.' },
              write: { type: 'boolean', description: 'May modify files. Defaults to false.' },
              shell: { type: 'boolean', description: 'May run commands. Defaults to false.' },
              message: { type: 'boolean', description: 'May post to the board and message peers. Defaults to true.' },
            },
            required: ['name', 'task', 'provider', 'model'],
          },
        },
      },
      required: ['objective'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: String(result) }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('协作台需要一个会话：本次调用没有携带 agent.session.id')
      }
      const objective = String(args?.objective ?? '').trim()
      if (objective === '') throw new Error('objective 不能为空')
      const models = Array.isArray(args?.models) ? args.models : undefined
      const roster = Array.isArray(args?.agents) && args.agents.length > 0
        ? args.agents.map(rosterRowOf)
        : (await hub.draft(sessionId, { objective, count: args?.count, models, signal: exec?.signal })).draft.agents
      // `exec.agent` is the exact live agent making the call, so the launch does
      // not have to look a parent up by session id and cannot come back empty.
      const launched = await hub.launch(
        sessionId,
        { objective, agents: roster, models, signal: exec?.signal },
        { parent: exec?.agent },
      )
      return describeLaunch(launched.agents)
    },
  }
}

/**
 * Map one tool-supplied roster row into the shape `Hub.launch` expects.
 *
 * Powers default to **off** here, unlike a UI-authored row: a model that did not
 * say `write: true` should not get a writing agent by accident. `message` is the
 * exception — the board is the point, so it defaults on.
 * @param {Record<string, any>} row - Row from the tool call.
 * @returns {Record<string, any>} Card-shaped spec.
 */
function rosterRowOf(row) {
  return {
    name: typeof row?.name === 'string' ? row.name : undefined,
    role: typeof row?.role === 'string' ? row.role : '',
    task: typeof row?.task === 'string' ? row.task : '',
    files: Array.isArray(row?.files) ? row.files : [],
    model: {
      provider: typeof row?.provider === 'string' ? row.provider.trim() : '',
      model: typeof row?.model === 'string' ? row.model.trim() : '',
      reasoningEffort: typeof row?.reasoningEffort === 'string' ? row.reasoningEffort : null,
    },
    powers: { write: row?.write === true, shell: row?.shell === true, message: row?.message !== false },
  }
}

/**
 * Render a launch result as the text the calling model reads back.
 * @param {Record<string, any>[]} agents - Started cards.
 * @returns {string} Summary.
 */
function describeLaunch(agents) {
  const lines = ['协作台已开台。', '', '队伍：']
  for (const card of agents) {
    const state = card.status === 'error'
      ? `启动失败（${card.error ?? '未知原因'}）`
      : `已启动 id=${card.id ?? '—'}`
    lines.push(`- ${card.name}${card.role === '' ? '' : ` — ${card.role}`}`
      + ` · ${card.model.provider}/${card.model.model}`
      + ` · ${card.powers.write ? '可写' : '只读'}${card.powers.shell ? '/可执行' : ''}`
      + ` · ${state}`)
    if (card.task !== '') lines.push(`  任务：${card.task}`)
    if (card.files.length > 0) lines.push(`  负责：${card.files.join('、')}`)
  }
  const failed = agents.filter(card => card.status === 'error').length
  lines.push('', '它们正在并行工作，进度板在界面上实时可见。用 `hub_read` 读同伴产出，用 `hub_post` 汇报你自己的里程碑。')
  if (failed > 0) {
    lines.push(`注意：有 ${failed} 个智能体启动失败，必要时换 provider/model 重试，或把它们的工作自己做掉。`)
  }
  return lines.join('\n')
}

/**
 * Register the hub's model-facing tools.
 * @param {Record<string, any>} ctx - Plugin context carrying the tool registry.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {() => void} Unregister.
 */
export function registerHubTools(ctx, hub) {
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') return () => {}
  const disposers = [hubPostTool(hub), hubReadTool(hub), hubLaunchTool(hub)].map(definition => {
    try {
      return ctx.tools.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`agent-hub: 注册工具 ${definition.name} 失败：${messageOf(error)}`)
      return undefined
    }
  })
  return () => {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          // Teardown races are not actionable.
        }
      }
    }
  }
}
