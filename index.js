/**
 * dsh-agent-hub, Host half.
 *
 * A board where several real agents — each on its own provider/model, each with
 * its own tool powers — run at the same time on one objective, and where the
 * humans and the agents watch the same progress feed.
 *
 * The whole feature is a projection over machinery this harness already has:
 * `ctx.subagents.startContinuable` publishes durable, steerable children,
 * `session/event` and `agent/assistant-stream` report what they are doing, and
 * `ctx.subagents.prompt` delivers a message into any of them. Nothing in this
 * plugin invents progress; it names it, splits it, and shows it.
 *
 * Wiring is deliberately lazy. `inject` names only `tools`, because that is the
 * one service a launch cannot work without; every other service is read through
 * `ctx.get` at the moment it is needed, so a deployment without a web server or
 * without an LLM still loads and simply reports the missing piece to the panel.
 *
 * @module dsh-agent-hub
 */

import { Config, normalizeConfig } from './src/config.js'
import { Hub } from './src/hub.js'
import { registerHubRoutes } from './src/http.js'
import { observeHub } from './src/observe.js'
import { registerHubTools } from './src/tools.js'

/** Host plugin name; must match the package name and the loader entry id. */
export const name = 'dsh-agent-hub'

/** The one service the plugin cannot run without. */
export const inject = ['tools']

export { Config, Hub }

/**
 * Load the plugin.
 * @param {Record<string, any>} ctx - Host plugin context.
 * @param {unknown} config - Raw configuration from the loader.
 * @returns {void}
 */
export function apply(ctx, config) {
  const validated = normalizeConfig(config)
  if ('issues' in validated) {
    // Fail at load, not at first use: a typo in cordis.patch.yml should be a
    // startup error the operator sees, not a launch that mysteriously refuses.
    const detail = validated.issues
      .map(issue => `${(issue.path ?? []).join('.')} ${issue.message}`.trim())
      .join('; ')
    throw new Error(`dsh-agent-hub: 配置无效 — ${detail}`)
  }
  const hub = new Hub({ ctx, settings: validated.value })
  ctx.effect(() => {
    const stops = [
      observeHub(ctx, hub),
      registerHubTools(ctx, hub),
      registerHubRoutes(ctx, hub),
    ]
    return () => {
      for (const stop of stops.reverse()) {
        if (typeof stop === 'function') stop()
      }
      hub.dispose()
    }
  }, 'agent-hub: wiring')
  ctx.logger?.info?.('agent-hub: 已就绪（多智能体协作台）')
}
