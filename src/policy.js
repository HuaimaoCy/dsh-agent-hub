/**
 * The standing instruction that makes agents actually reach for the hub.
 *
 * A tool alone does not produce the behaviour. A model that has never been told
 * what the board is for keeps solving everything single-threaded; a model told
 * to "use it a lot" spawns teams for two-line edits and pays a coordinator call
 * plus N agent contexts for work that took one step. Both failures come from the
 * same omission, so this text is a **policy**, not a cheer:
 *
 * - explicit **triggers** — the shapes of problem where parallelism pays;
 * - explicit **anti-triggers** — the shapes where it is a net loss, stated as
 *   plainly as the triggers so they carry the same weight;
 * - the mechanics, so an agent that knows *when* also knows *how*;
 * - one live line about the board as it is right now, so an agent joins the team
 *   that already exists instead of opening a second one on top of it.
 *
 * That last line is why the section takes a callback rather than a constant: the
 * prompt is assembled per request, so the text can describe the current board.
 *
 * @module dsh-agent-hub/src/policy
 */

import { phaseOf } from './hub.js'

/**
 * The policy text.
 *
 * Every clause here earns its place in a prompt that is sent on **every request
 * of every session in the deployment**, so it is written tight on purpose: the
 * triggers are the part that has to survive being skimmed, and the
 * anti-triggers exist because an agent that only reads "use it for breadth"
 * will happily parallelise a task that was three sequential steps.
 */
export const HUB_POLICY = [
  '## 协作台（Agent Hub）：什么时候把问题摊开并行处理',
  '',
  '本会话有一块「协作台」：可以用**不同模型**同时跑多个智能体，各自负责互不重叠的文件，共用一张进度板，界面上实时可见。',
  '',
  '**满足任意一条，就应当开台，而不是自己顺序做完：**',
  '- 目标能拆成 2 个以上**互相独立**的子问题，文件或模块范围可以不重叠。',
  '- 要的是**广度**：多个模块、多个方案、多个数据源上的同类排查或对比。',
  '- 需要一个**不同模型**的判断——设计取舍、方案评审、结论证伪。换个模型跑一遍，比同一模型自我复核更容易发现问题。',
  '- 主体工作耗时较长，而你不该让用户干等：把长的部分派出去，主线继续和用户对话。',
  '- 需要**对抗性验证**：让一个只读角色去攻击另一个角色的产出。',
  '',
  '**不要开台**（这些情况下单线程更快、更准、更省）：',
  '- 步骤之间有依赖，后一步要用前一步的结果。',
  '- 只有一处文件要改，或者几个角色注定写同一批文件。',
  '- 两三步就能做完的小事——开台本身有成本（一次协调者调用，加上每个智能体各自的上下文与工具循环），小任务上并行是净亏。',
  '- 你没法在一条提示里把必要背景交代清楚：子智能体看不到这段对话。',
  '',
  '**怎么用：**',
  '- 用 `hub_launch` 开台。只给目标，由协调者模型自动拆分角色；也可以直接指定角色与模型。',
  '- 开台后立刻用一句话告诉用户「谁在做什么、在哪儿看」，然后继续做你自己那一份。',
  '- 想看同伴进展或读它们的产出用 `hub_read`；汇报自己的里程碑用 `hub_post`，它会实时出现在界面上。',
  '- 一个会话只维护一块台：已经有台在跑时，用 `hub_post` / `hub_read` 与它协作，不要再开一块。',
  '- 协作台与 DSH 原生的 **Agent Teams 是同一块板**：原生团队成员与原生任务板都会显示在这里，而 `hub_launch` 审批过的分工会被写成**原生任务**——所以团队面板与 `team_task_list` 看到的是同一份计划，不必在两处分别维护。',
].join('\n')

/**
 * One line describing the board of the session this prompt is for.
 * @param {Record<string, any>|undefined} board - The board, when the session has one.
 * @returns {string} Status line.
 */
export function hubStatusLine(board) {
  if (board === undefined || board.agents.length === 0) {
    return '当前会话还没有协作台。'
  }
  const running = board.agents.filter(card => card.status === 'running').length
  const settled = board.agents.filter(card => card.status === 'done').length
  const failed = board.agents.filter(card => card.status === 'error' || card.status === 'stopped').length
  const names = board.agents.map(card => card.name).join('、')
  const parts = [`${board.agents.length} 个智能体（${names}）`]
  if (running > 0) parts.push(`${running} 个正在跑`)
  if (settled > 0) parts.push(`${settled} 个已完成`)
  if (failed > 0) parts.push(`${failed} 个失败或被停`)
  return `当前会话已有一块协作台（阶段 ${phaseOf(board)}）：${parts.join('，')}。`
}

/**
 * Build the section text for one prompt assembly.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @param {Record<string, any>} [context] - Assembly context carrying `agent.session.id`.
 * @returns {string} The section body.
 */
export function hubPolicyText(hub, context) {
  const sessionId = context?.agent?.session?.id
  const board = typeof sessionId === 'string' && sessionId !== '' ? hub.peek(sessionId) : undefined
  return [HUB_POLICY, '', hubStatusLine(board)].join('\n')
}

/**
 * Register the policy as a standing system-prompt section.
 *
 * Optional by design: a deployment may compose no `systemPrompt` service (the
 * section is then skipped), and an operator may switch it off through the
 * `policy` config option — this text is the reason the plugin influences every
 * request in the deployment, so it has to be possible to turn it off.
 * @param {Record<string, any>} ctx - Plugin context.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @param {Record<string, any>} settings - Normalized config.
 * @returns {() => void} Disposer.
 */
export function registerHubPolicy(ctx, hub, settings) {
  if (settings.policy !== true) return () => {}
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') {
    return () => {}
  }
  try {
    const dispose = systemPrompt.section({
      name: 'agent-hub-policy',
      // Late enough to sit with the other behavioural guidance rather than
      // interrupting the harness's own opening sections.
      order: 60,
      text: context => hubPolicyText(hub, context),
    })
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    ctx.logger?.warn?.(`agent-hub: 注册协作台策略段落失败：${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}
