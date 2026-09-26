/**
 * The bridge to the harness's own Agent Teams runtime.
 *
 * Both features answer the same question — "several agents, one board" — so the
 * honest integration is not to reimplement the other one. It is to stop keeping
 * a second truth:
 *
 * - **The harness owns durability.** Member and task records live in the Lead
 *   session's log (`team/member`, `team/task`, …), which is why the hub *reads*
 *   them through `ctx.agentTeams` instead of maintaining a rival roster. A team
 *   the model built itself with the native `spawn_teammate` / `team_task_*` tools
 *   therefore shows up on the hub's board with no extra work, and survives restarts
 *   the hub's own in-memory projection does not.
 * - **The hub owns what the team runtime cannot express**: a per-agent model, a
 *   per-agent tool scope, and the live token-level view. `SpawnTeammateRequest`
 *   carries `provider` but no model (`packages/experimental/agent-team/src/types.ts:166`),
 *   so a teammate inherits the Lead's model.
 *
 * **What this bridge deliberately does not do is adopt hub agents as team
 * members.** The team service has no adopt API and its only spawn path is the
 * model-less one above, so adopting would cost every agent its model — the whole
 * point of the feature. Instead the hub publishes its plan as **team tasks**,
 * which is exactly the durable half the team feature models properly: the same
 * task board, the same revisions, the same write scopes, visible in the native
 * Team UI and to the native `team_task_*` tools.
 *
 * The task lifecycle was verified against the live runtime before this module was
 * written: `createTask` (pending, revision 1) → `claim` (in_progress, revision 2,
 * ownerName `lead`) → `complete` (revision 3). `complete` refuses a task that was
 * never claimed, which is why {@link startTasks} claims at launch rather than
 * waiting until settle.
 *
 * @module dsh-agent-hub/src/team
 */

/**
 * Read a message out of anything thrown, without importing from the hub (which
 * imports this module).
 * @param {unknown} error - Thrown value.
 * @returns {string} Message.
 */
function readError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/**
 * The team service, when this deployment composes one.
 * @param {Record<string, any>} ctx - Plugin context.
 * @returns {Record<string, any>|undefined} Service, or undefined.
 */
export function teamServiceOf(ctx) {
  const service = ctx.get?.('agentTeams')
  if (service === undefined || service === null) return undefined
  return typeof service.tryMembership === 'function' && typeof service.listMembers === 'function'
    ? service
    : undefined
}

/**
 * Map one runtime member row to the shape the panel consumes.
 * @param {Record<string, any>} member - `TeamMemberView`.
 * @returns {Record<string, any>} Wire row.
 */
function wireMember(member) {
  return {
    id: String(member.id),
    name: String(member.name),
    role: member.role === 'lead' ? 'lead' : 'teammate',
    status: String(member.status),
    ...(member.description === undefined ? {} : { description: String(member.description) }),
    ...(member.provider === undefined ? {} : { provider: String(member.provider) }),
    ...(member.model === undefined ? {} : { model: String(member.model) }),
  }
}

/**
 * Map one runtime task row to the shape the panel consumes.
 * @param {Record<string, any>} task - `TeamTaskView`.
 * @returns {Record<string, any>} Wire row.
 */
function wireTask(task) {
  return {
    id: String(task.id),
    revision: Number(task.revision),
    subject: String(task.subject),
    description: String(task.description),
    status: String(task.status),
    ready: task.ready === true,
    writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.map(String) : [],
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    ...(task.ownerName === undefined ? {} : { ownerName: String(task.ownerName) }),
  }
}

/**
 * Read the durable team state for one lead agent.
 *
 * Never throws: a missing service, a caller that is not a team member, or a
 * malformed durable stream all degrade to "nothing to merge", because this runs
 * on every board read and must not be able to break the panel.
 * @param {Record<string, any>} ctx - Plugin context.
 * @param {Record<string, any>} lead - Exact live lead Agent, when one exists.
 * @returns {{ available: boolean, readable: boolean, members: Record<string, any>[], tasks: Record<string, any>[], error: string|null }} Team state.
 */
export function readTeam(ctx, lead) {
  const service = teamServiceOf(ctx)
  if (service === undefined) return { available: false, readable: false, members: [], tasks: [], error: null }
  if (lead === undefined || lead === null) {
    return { available: true, readable: false, members: [], tasks: [], error: '这个会话当前没有活动的智能体，读不到团队状态' }
  }
  try {
    // `tryMembership` treats any live root agent as the lead of its own (possibly
    // empty) team, so a fresh session reads as an empty roster rather than an
    // error. A subagent returns undefined, which is a legitimate "no team here".
    if (service.tryMembership(lead) === undefined) {
      return { available: true, readable: true, members: [], tasks: [], error: null }
    }
    const members = service.listMembers(lead).map(wireMember)
    const tasks = service.listTasks(lead).map(wireTask)
    return { available: true, readable: true, members, tasks, error: null }
  } catch (error) {
    return { available: true, readable: false, members: [], tasks: [], error: readError(error) }
  }
}

/**
 * Publish one hub agent as a team task, claimed so it can later be completed.
 *
 * The task is owned by the **Lead**, because the board only authorizes known
 * members and the dispatched agent is not one — so the agent's identity is
 * carried in the subject instead of the owner field, where it would be a lie.
 * @param {Record<string, any>} service - Team service.
 * @param {Record<string, any>} lead - Exact live lead Agent.
 * @param {Record<string, any>} card - Agent card.
 * @returns {Promise<{ taskId: string|null, revision: number|null, error: string|null }>} Outcome.
 */
async function publishOne(service, lead, card) {
  try {
    const created = await service.createTask(lead, {
      subject: `${card.name}${card.role === '' ? '' : ` — ${card.role}`}`.slice(0, 120),
      description: card.task,
      ...(card.files.length === 0 ? {} : { writeScopes: card.files }),
    })
    // `complete` refuses a task that was never claimed, so the claim happens here
    // rather than at settle time, when the task may already be stale.
    const claimed = await service.updateTask(lead, {
      taskId: created.id,
      expectedRevision: created.revision,
      action: 'claim',
    })
    return { taskId: String(created.id), revision: Number(claimed.revision), error: null }
  } catch (error) {
    return { taskId: null, revision: null, error: readError(error) }
  }
}

/**
 * Publish a launched roster as team tasks.
 *
 * Best-effort per card, and non-fatal overall: the agents are already running, so
 * a board that refuses a row must not cancel the launch. The failure is recorded
 * on the card and reported once, so it is visible rather than silent.
 * @param {Record<string, any>} ctx - Plugin context.
 * @param {Record<string, any>} lead - Exact live lead Agent.
 * @param {Record<string, any>[]} cards - Started cards.
 * @returns {Promise<{ published: number, skipped: boolean, error: string|null }>} Outcome.
 */
export async function publishPlan(ctx, lead, cards) {
  const service = teamServiceOf(ctx)
  if (service === undefined) return { published: 0, skipped: true, error: null }
  if (lead === undefined || lead === null) {
    return { published: 0, skipped: false, error: '没有活动的 Lead 智能体，任务未写入原生任务板' }
  }
  let published = 0
  let firstError = null
  for (const card of cards) {
    if (card.status === 'error') continue
    const outcome = await publishOne(service, lead, card)
    if (outcome.taskId === null) {
      firstError ??= outcome.error
      continue
    }
    card.teamTaskId = outcome.taskId
    card.teamTaskRevision = outcome.revision
    published += 1
  }
  return { published, skipped: false, error: firstError }
}

/**
 * Complete the team task behind one settled agent.
 *
 * A compare-and-set that loses means somebody else already moved the task, so the
 * failure is recorded and **not** retried: retrying blind would complete whatever
 * revision happens to be current, which is a different task than the one that
 * finished.
 * @param {Record<string, any>} ctx - Plugin context.
 * @param {string} sessionId - Parent session id, to resolve the lead Agent.
 * @param {Record<string, any>} card - Settled card.
 * @returns {Promise<{ completed: boolean, error: string|null }>} Outcome.
 */
export async function settleTask(ctx, sessionId, card) {
  const service = teamServiceOf(ctx)
  if (service === undefined || card.teamTaskId === undefined) return { completed: false, error: null }
  const lead = ctx.get?.('agents')?.get?.(sessionId)
  if (lead === undefined || lead === null) {
    return { completed: false, error: 'Lead 会话已不在活动中，原生任务板上的这一条保持原状' }
  }
  try {
    const next = await service.updateTask(lead, {
      taskId: card.teamTaskId,
      expectedRevision: card.teamTaskRevision,
      action: 'complete',
    })
    card.teamTaskRevision = Number(next.revision)
    return { completed: true, error: null }
  } catch (error) {
    return { completed: false, error: readError(error) }
  }
}
