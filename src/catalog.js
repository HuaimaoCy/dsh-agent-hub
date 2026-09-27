/**
 * Route metadata: pricing, quota posture, capability boundaries and strengths.
 *
 * The coordinator used to see bare `provider/model` strings, so a model choice
 * could only be made on the coordinator's own (often wrong) prior — the classic
 * failure is putting bulk mechanical work on the most expensive flagship and
 * then discovering the quota is gone. This module attaches what a chooser
 * actually needs:
 *
 * - **cost** — an estimated input/output price per million tokens, or a
 *   subscription posture when the route has no metered price;
 * - **quota posture** — how scarce the route tends to be (rate limits, daily
 *   caps), so bulk roles avoid hogging a thin route;
 * - **strengths / boundaries** — what the model is good at and where it breaks
 *   (no vision, weak long-context, tool-use quirks).
 *
 * Everything here is a **static estimate** operators can correct per deployment
 * through the `routeMeta` config option; unknown routes degrade to a neutral
 * line rather than blocking a launch.
 *
 * @module dsh-agent-hub/src/catalog
 */

/**
 * Built-in metadata, keyed by exact `provider/model` or by `provider` alone
 * (the prefix match is the fallback for models not listed individually).
 *
 * `cost` uses USD per million tokens `{ in, out }` as estimates; `metered:
 * false` marks routes paid by subscription where token price is meaningless.
 * @type {Record<string, { label?: string, in?: number, out?: number, metered?: boolean, tier?: 'free'|'cheap'|'mid'|'high', quota?: 'ample'|'normal'|'thin', strengths?: string, boundaries?: string }>}
 */
const BUILTIN_META = {
  // deepseek-official — metered, cheap-to-mid, generous quota.
  'deepseek-official/deepseek-flash': {
    in: 0.1, out: 0.4, tier: 'cheap', quota: 'ample',
    strengths: '快速、便宜，适合机械性批量任务：格式整理、清单核对、简单检索与改写',
    boundaries: '复杂推理与高风险架构决策不可靠；不要用于对抗性评审的主力',
  },
  'deepseek-official/deepseek-v4-pro': {
    in: 0.5, out: 2, tier: 'mid', quota: 'normal',
    strengths: '强推理与长文分析，适合设计取舍、方案评审、结论证伪',
    boundaries: '比 flash 贵一个量级，批量机械任务用它纯属浪费',
  },
  'deepseek-official': { tier: 'mid', quota: 'normal', strengths: '通用对话与编码', boundaries: '' },

  // zai-coding-cn — metered, coding-oriented.
  'zai-coding-cn/glm-5-turbo': {
    in: 0.2, out: 0.6, tier: 'cheap', quota: 'ample',
    strengths: '低延迟编码执行：小改动、批量重构、测试补齐',
    boundaries: '深推理与跨模块设计偏弱',
  },
  'zai-coding-cn/glm-4.7': {
    in: 0.9, out: 0.9, tier: 'mid', quota: 'normal',
    strengths: '编码主力：实现、调试、重构，代码质量稳',
    boundaries: '无订阅兜底，长任务注意用量',
  },
  'zai-coding-cn/glm-4.6v': {
    in: 0.9, out: 0.9, tier: 'mid', quota: 'normal',
    strengths: '视觉理解：截图走查、UI 对比、图像证据核对',
    boundaries: '纯文本任务不要为“视觉”付溢价',
  },
  'zai-coding-cn': { tier: 'mid', quota: 'normal', strengths: '编码', boundaries: '' },

  // codex-chatgpt — subscription (ChatGPT sign-in), no per-token price; the
  // scarce resource is the account, not the meter.
  'codex-chatgpt/gpt-6-astra': { metered: false, tier: 'high', quota: 'thin', strengths: '最强判断力：架构裁决、疑难排错、最终评审', boundaries: '订阅额度最紧张，只给判断密集角色，禁做批量机械活' },
  'codex-chatgpt/gpt-6-sol': { metered: false, tier: 'high', quota: 'thin', strengths: '复杂推理与规划', boundaries: '订阅额度紧张，慎用于批量任务' },
  'codex-chatgpt/gpt-6-luna': { metered: false, tier: 'mid', quota: 'thin', strengths: '均衡推理与写作', boundaries: '订阅额度紧张' },
  'codex-chatgpt/gpt-5.6-sol': { metered: false, tier: 'mid', quota: 'thin', strengths: '可靠推理', boundaries: '订阅额度紧张' },
  'codex-chatgpt/gpt-5.6-terra': { metered: false, tier: 'mid', quota: 'thin', strengths: '扎实执行与编码', boundaries: '订阅额度紧张' },
  'codex-chatgpt/gpt-5.6-luna': { metered: false, tier: 'cheap', quota: 'thin', strengths: '轻量快速', boundaries: '订阅额度紧张，不要铺满整个团队' },
  'codex-chatgpt/gpt-5.5': { metered: false, tier: 'mid', quota: 'thin', strengths: '通用', boundaries: '订阅额度紧张' },
  'codex-chatgpt': { metered: false, tier: 'high', quota: 'thin', strengths: '强判断', boundaries: '订阅额度紧张' },
}

/** Compact Chinese tag per cost tier, for one-glance prompt lines. */
const TIER_TAG = { free: '免费', cheap: '低价', mid: '中价', high: '高价' }
/** Compact Chinese tag per quota posture. */
const QUOTA_TAG = { ample: '额度充裕', normal: '额度一般', thin: '额度紧张' }

/**
 * Look up metadata for one route: exact match first, then provider prefix.
 * @param {string} route - `provider/model` string.
 * @param {Record<string, Record<string, any>>} [overrides] - Operator-supplied `routeMeta` config.
 * @returns {Record<string, any>|undefined} The merged entry, or undefined when unknown.
 */
export function routeMetaOf(route, overrides) {
  if (typeof route !== 'string' || route === '') return undefined
  const override = overrides?.[route]
  const cut = route.indexOf('/')
  const providerKey = cut > 0 ? route.slice(0, cut) : route
  const builtin = BUILTIN_META[route] ?? BUILTIN_META[providerKey]
  if (override === undefined && builtin === undefined) return undefined
  return { ...(builtin ?? {}), ...(override ?? {}) }
}

/**
 * One compact annotated line for one route, or the bare route when unknown.
 *
 * Kept to a single line because these ride in prompts: the format is
 * `route｜成本 tag＋价格｜额度 tag｜强项｜边界`.
 * @param {string} route - `provider/model` string.
 * @param {Record<string, Record<string, any>>} [overrides] - Operator `routeMeta` config.
 * @returns {string} The annotated line.
 */
export function annotateRoute(route, overrides) {
  const meta = routeMetaOf(route, overrides)
  if (meta === undefined) return route
  const parts = []
  const price = meta.metered === false
    ? '订阅制（不按 token 计价）'
    : (typeof meta.in === 'number' && typeof meta.out === 'number'
        ? `约 $${meta.in}/$${meta.out} 每百万 token（入/出）`
        : '')
  if (TIER_TAG[meta.tier] !== undefined || price !== '') {
    parts.push(`成本：${[TIER_TAG[meta.tier], price].filter(Boolean).join('，')}`)
  }
  if (QUOTA_TAG[meta.quota] !== undefined) parts.push(`额度：${QUOTA_TAG[meta.quota]}`)
  if (typeof meta.strengths === 'string' && meta.strengths !== '') parts.push(`擅长：${meta.strengths}`)
  if (typeof meta.boundaries === 'string' && meta.boundaries !== '') parts.push(`边界：${meta.boundaries}`)
  return parts.length === 0 ? route : `${route}｜${parts.join('｜')}`
}

/**
 * Annotate a route list for the coordinator request.
 * @param {string[]} routes - Raw `provider/model` strings.
 * @param {Record<string, Record<string, any>>} [overrides] - Operator `routeMeta` config.
 * @returns {string[]} Annotated lines, same order and length.
 */
export function annotateRoutes(routes, overrides) {
  if (!Array.isArray(routes)) return []
  return routes.map(route => annotateRoute(route, overrides))
}

/**
 * A short cost tier tag appended in the standing policy line, e.g.
 * `deepseek-official/deepseek-flash（低价）`. Empty when unknown.
 *
 * The operator overrides must be passed here too: the coordinator's annotated list
 * and the policy line describe the same routes, and computing them from different
 * views is how the two ends up disagreeing about what a route costs.
 * @param {string} route - `provider/model` string.
 * @param {Record<string, Record<string, any>>} [overrides] - Operator `routeMeta` config.
 * @returns {string} `（tag）` or ''.
 */
export function tierTagOf(route, overrides) {
  const meta = routeMetaOf(route, overrides)
  const tag = TIER_TAG[meta?.tier]
  return tag === undefined ? '' : `（${tag}）`
}
