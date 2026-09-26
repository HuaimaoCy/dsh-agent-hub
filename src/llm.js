/**
 * The coordinator call: one objective in, a set of role rows out.
 *
 * The call goes through `ctx.llm.stream` — the harness's one-shot model egress
 * — so it never enters a session log, never wakes an idle agent, and never
 * replays through the agent loop. Cancellation and provider failure arrive as
 * terminal `finish` chunks rather than thrown errors, which is why the stream
 * is drained to its end and classified explicitly: a truncated plan must be
 * rejected, not silently launched as a team with missing roles.
 *
 * @module dsh-agent-hub/src/llm
 */

import { COORDINATOR_SYSTEM_PROMPT, buildCoordinatorRequest } from './prompt.js'

/** How long one coordinator call may take, when the caller gives no deadline. */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * Classify a terminal stream reason.
 * @param {{ kind: string, failure?: { code?: string, message?: string } }|undefined} finish - Terminal reason, when one arrived.
 * @returns {Error|undefined} The failure to raise, or undefined when the stream completed.
 */
export function finishError(finish) {
  if (finish === undefined) return undefined
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new Error(`调用协调者模型失败（${finish.kind}）：${finish.failure?.code ?? 'UNKNOWN'}: ${finish.failure?.message ?? '无详情'}`)
    case 'max-tokens':
      return new Error('协调者输出在 token 上限处被截断，分工方案不完整')
    default:
      return undefined
  }
}

/**
 * Combine a caller signal with a deadline.
 * @param {AbortSignal|undefined} signal - Caller cancellation.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {{ signal: AbortSignal, dispose: () => void }} The derived signal and its cleanup.
 */
export function withDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => { controller.abort(signal?.reason) }
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => { controller.abort(new Error(`协调者调用超过 ${timeoutMs}ms`)) }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Recover the JSON object a model produced, tolerating a fenced block.
 * @param {string} text - Raw model output.
 * @returns {Record<string, any>} The parsed object.
 * @throws {Error} When no JSON object can be recovered.
 */
export function parsePlanJson(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced === null ? raw : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('协调者没有返回 JSON 对象')
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch (error) {
    throw new Error(`协调者返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('协调者返回的顶层值不是对象')
  }
  return parsed
}

/**
 * Turn the parsed plan into launchable rows.
 *
 * A row a model got wrong is repaired where the intent is unambiguous (a
 * missing name, a missing files list) and dropped only when the row carries no
 * task at all — shipping a role with no work would produce an agent that burns
 * tokens discovering it has nothing to do.
 * @param {Record<string, any>} plan - Parsed coordinator output.
 * @param {{ count: number, route: { provider: string, model: string }, defaults: { write: boolean, shell: boolean }, routes?: Set<string> }} options - Normalization inputs.
 * @returns {Record<string, any>[]} Agent rows.
 * @throws {Error} When no usable row remains.
 */
export function normalizeAgents(plan, options) {
  const rows = Array.isArray(plan?.agents) ? plan.agents : []
  if (rows.length === 0) throw new Error('协调者没有给出任何角色（agents 为空）')
  const agents = []
  for (const [index, row] of rows.slice(0, options.count).entries()) {
    if (row === null || typeof row !== 'object') continue
    const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : `智能体 ${index + 1}`
    const role = typeof row.role === 'string' ? row.role.trim() : ''
    const task = typeof row.task === 'string' && row.task.trim() !== '' ? row.task.trim() : role
    if (task === '') continue
    const model = pickRoute(row, options)
    agents.push({
      clientId: `a${index + 1}`,
      name,
      role,
      task,
      files: Array.isArray(row.files)
        ? row.files.filter(file => typeof file === 'string' && file.trim() !== '').map(file => file.trim()).slice(0, 20)
        : [],
      model,
      powers: {
        write: row.write === undefined ? options.defaults.write : row.write === true,
        shell: row.shell === undefined ? options.defaults.shell : row.shell === true,
        message: row.message === undefined ? true : row.message === true,
      },
    })
  }
  if (agents.length === 0) throw new Error('协调者给出的角色都没有可执行的任务')
  return agents
}

/**
 * Ask the coordinator to split one objective.
 * @param {object} request - Call request.
 * @param {Record<string, any>} request.ctx - Plugin context carrying the optional `llm` service.
 * @param {{ provider: string, model: string }} request.route - Coordinator route.
 * @param {string} request.objective - Team objective.
 * @param {number} request.count - Requested number of agents.
 * @param {string} request.sessionId - Session the call is attributed to.
 * @param {number} request.maxTokens - Output cap.
 * @param {number} request.timeoutMs - Deadline.
 * @param {AbortSignal} [request.signal] - Caller cancellation.
 * @param {{ write: boolean, shell: boolean }} request.defaults - Powers for rows that omit them.
 * @returns {Promise<{ agents: Record<string, any>[], usage: unknown, route: { provider: string, model: string } }>} Rows plus call metadata.
 */
export async function draftPlan(request) {
  const llm = request.ctx.get?.('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('这个部署没有可用的 llm 服务，无法调用协调者模型')
  }
  const deadline = withDeadline(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const options = {
      provider: request.route.provider,
      model: request.route.model,
      // A one-shot caller owns the system slot; the agent-loop rule that keeps
      // it undefined applies only to loop-built requests.
      system: COORDINATOR_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: buildCoordinatorRequest({
            objective: request.objective,
            count: request.count,
            files: await workspaceHints(request.ctx),
          }),
        }],
      }],
      maxTokens: request.maxTokens,
      signal: deadline.signal,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    }
    let text = ''
    let usage
    /** @type {{ kind: string, failure?: { code?: string, message?: string } }|undefined} */
    let finish
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (deadline.signal.aborted) throw new Error('调用协调者模型被取消或超时')
    const failure = finishError(finish)
    if (failure !== undefined) throw failure
    if (text.trim() === '') throw new Error('协调者返回了空内容')
    const plan = parsePlanJson(text)
    return {
      agents: normalizeAgents(plan, {
        count: request.count,
        route: request.route,
        defaults: request.defaults,
        routes: await routeSet(request.ctx),
      }),
      usage,
      route: request.route,
    }
  } finally {
    deadline.dispose()
  }
}

/**
 * Read the working directory's top-level names, so the coordinator can assign
 * real paths instead of inventing them. Best-effort: a workspace that cannot be
 * read simply yields no hints.
 * @param {Record<string, any>} ctx - Plugin context.
 * @returns {Promise<string[]>} Entry names.
 */
async function workspaceHints(ctx) {
  try {
    const workspace = ctx.get?.('workspace')
    const root = workspace?.root?.()
    const cwd = typeof root === 'string' ? root : workspace?.cwd
    if (typeof cwd !== 'string' || cwd === '') return []
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(cwd, { withFileTypes: true })
    return entries
      .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .slice(0, 60)
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  } catch {
    return []
  }
}

/**
 * Every `provider/model` the runtime advertises, for validating a suggestion.
 * @param {Record<string, any>} ctx - Plugin context.
 * @returns {Promise<Set<string>>} Advertised routes.
 */
async function routeSet(ctx) {
  const routes = new Set()
  try {
    const llm = ctx.get?.('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return routes
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) routes.add(`${provider.id}/${model.id}`)
      } catch {
        // An unreachable provider contributes no routes; a suggestion naming it
        // then falls back to the coordinator's own route instead of failing.
      }
    }
  } catch {
    return routes
  }
  return routes
}

/** Pick a row's route: the model's suggestion when it is real, else the coordinators'. */
function pickRoute(row, options) {
  const provider = typeof row?.model?.provider === 'string' ? row.model.provider
    : (typeof row?.provider === 'string' ? row.provider : '')
  const model = typeof row?.model?.model === 'string' ? row.model.model
    : (typeof row?.model === 'string' ? row.model : '')
  const effort = typeof row?.model?.reasoningEffort === 'string' ? row.model.reasoningEffort
    : (typeof row?.reasoningEffort === 'string' ? row.reasoningEffort : null)
  if (provider !== '' && model !== '' && (options.routes === undefined || options.routes.size === 0
    || options.routes.has(`${provider}/${model}`))) {
    return { provider, model, reasoningEffort: effort }
  }
  return { provider: options.route.provider, model: options.route.model, reasoningEffort: effort }
}
