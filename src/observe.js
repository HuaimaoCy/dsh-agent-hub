/**
 * Event wiring: the harness's own signals, folded into the boards.
 *
 * The hub is a projection over events the harness already emits, so this module
 * is the entire "input" side of the feature:
 *
 * | event | what it adds |
 * |---|---|
 * | `session/event` | committed progress: turns, steps, tool calls, replies |
 * | `agent/assistant-stream` | token-level in-flight text |
 * | `agent/status` | running/idle transitions between turns |
 * | `subagent/start` | a child was published |
 * | `subagent/end` | the child settled — the only source of a terminal status |
 *
 * Every listener is registered through `ctx.on`, which Cordis scopes to this
 * plugin's fiber: unloading the plugin removes them, so nothing here needs its
 * own bookkeeping beyond a belt-and-braces disposer list for non-Cordis hosts.
 *
 * @module dsh-agent-hub/src/observe
 */

import { messageOf } from './hub.js'

/**
 * Attach the hub to the host event stream.
 * @param {Record<string, any>} ctx - Plugin context.
 * @param {import('./hub.js').Hub} hub - The hub to feed.
 * @returns {() => void} Detach.
 */
export function observeHub(ctx, hub) {
  const offs = []
  const on = (event, handler) => {
    try {
      const off = ctx.on(event, handler)
      if (typeof off === 'function') offs.push(off)
    } catch (error) {
      // An event this build does not declare must not stop the others from
      // being wired: the hub still works with whatever it did get.
      ctx.logger?.warn?.(`agent-hub: 订阅 ${event} 失败：${messageOf(error)}`)
    }
  }

  on('session/event', (session, event) => { hub.noteSessionEvent(session, event) })
  on('agent/assistant-stream', (payload) => { hub.noteAssistantStream(payload?.agent, payload?.frame) })
  on('agent/status', (payload) => { hub.noteAgentStatus(payload) })
  on('subagent/start', (info) => { hub.noteSubagentStart(info) })
  on('subagent/end', (info) => { hub.noteSubagentEnd(info) })

  return () => {
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        // Detaching an already-torn-down listener is not worth a failure.
      }
    }
  }
}
