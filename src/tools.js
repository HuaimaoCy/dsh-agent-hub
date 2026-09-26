/**
 * The two tools the agents themselves use to exchange progress.
 *
 * The board the humans watch and the board the agents write to are the same
 * board on purpose: a separate machine-to-machine channel would let the UI and
 * the agents disagree about what happened. `hub_post` appends to that feed and,
 * when addressed to a peer, also delivers the text into that peer's inbox, so
 * "tell the others" is one action rather than a post plus a hope.
 *
 * Both tools are registered on the plugin's root context, which means every
 * agent in the deployment can see them. An agent that belongs to no board gets
 * a clear 409-style error from the call rather than a silently dropped message.
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
  return lines.join('\n')
}

/**
 * Register both tools.
 * @param {Record<string, any>} ctx - Plugin context carrying the tool registry.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {() => void} Unregister.
 */
export function registerHubTools(ctx, hub) {
  if (ctx.tools === undefined || typeof ctx.tools.register !== 'function') return () => {}
  const disposers = [hubPostTool(hub), hubReadTool(hub)].map(definition => {
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
