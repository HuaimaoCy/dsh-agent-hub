/**
 * Cross-half contract test for dsh-agent-hub.
 *
 * The two halves never share code — they share `CONTRACT.md` and the wire. That
 * makes the seam the most likely place for a silent break, and neither half's
 * own smoke test can see it: the Host half passes while sending a status the
 * browser half does not understand, and the browser half passes while building a
 * launch payload the Host half rejects.
 *
 * So this file runs both for real against each other:
 *
 * 1. drives the **Host half** through its own route to a realistic board;
 * 2. feeds that exact payload into the **browser half's** pure functions;
 * 3. takes the payload the browser half builds for `launch` and posts it back
 *    through the Host half's validation.
 *
 * Run: node --no-warnings tests/integration.mjs
 *
 * @module dsh-agent-hub/tests/integration
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply as loadPlugin } from '../index.js'

process.on('unhandledRejection', (reason) => {
  console.error('FAIL unhandled rejection in the suite:', reason)
  process.exitCode = 1
})

const failures = []
let passed = 0

/**
 * Run one assertion group.
 * @param {string} label - What is being checked.
 * @param {() => unknown} body - Assertion body, sync or async.
 * @returns {Promise<void>} Resolves after the check.
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Host half harness
 * ------------------------------------------------------------------ */

const routes = []
const startCalls = []
const promptCalls = []
const parentAgent = {
  id: 'session-parent',
  session: { id: 'session-parent', requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
}
const plan = JSON.stringify({
  agents: [
    { name: '架构', role: '接口设计', task: '给出模块边界', files: ['src/http.js'], write: true, shell: false, message: true },
    { name: '评审', role: '对抗评审', task: '找漏洞', files: [], write: false, shell: false, message: true },
  ],
})
const services = {
  agents: { get: id => (id === 'session-parent' ? parentAgent : undefined) },
  subagents: {
    list: () => ['spawn'],
    startContinuable: async (spec) => {
      startCalls.push(spec)
      return { childId: `child-${startCalls.length}`, messageId: `msg-${startCalls.length}` }
    },
    prompt: async (request) => {
      promptCalls.push(request)
      return { messageId: 'pm' }
    },
    interrupt: () => {},
  },
  llm: {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }],
    stream: async function* stream() {
      yield { type: 'text-delta', text: plan }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  webServer: { register: (entry) => { routes.push(entry); return () => {} } },
}

const toolStorage = new Map()
const handlers = new Map()
const hostCtx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {
    register: (definition) => { toolStorage.set(definition.name, definition); return () => {} },
    get: name => toolStorage.get(name),
  },
  on: (event, handler) => { handlers.set(event, handler); return () => {} },
  effect: (run) => { run() },
  get: name => services[name],
}
loadPlugin(hostCtx, { provider: 'spawn' })
const route = routes[0]

/** Drive one operation through the Host half's real route. */
async function host(op, { method = 'GET', query = {}, body, marker = true } = {}) {
  const params = new URLSearchParams({ op, ...query })
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/agent-hub?${params.toString()}`,
    headers: { host: '127.0.0.1:3080', ...(marker ? { 'x-dsh-agent-hub': '1' } : {}) },
    on: () => {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let text = ''
  await route.handler(req, { writeHead: code => { status = code }, end: payload => { text = String(payload ?? '') } })
  return { status, payload: JSON.parse(text) }
}

const sessionId = 'session-parent'
const drafted = await host('draft', { method: 'POST', body: { op: 'draft', sessionId, objective: '把构建迁移到 pnpm', count: 2 } })
assert.equal(drafted.status, 200, 'host draft must succeed for the integration test to be meaningful')
const launched = await host('launch', {
  method: 'POST',
  body: { op: 'launch', sessionId, objective: '把构建迁移到 pnpm', agents: drafted.payload.result.draft.agents },
})
assert.equal(launched.status, 200, 'host launch must succeed for the integration test to be meaningful')
const childIds = launched.payload.result.agents.map(agent => agent.id)

// Move the board through the states the panel has to render: a tool call, a
// streamed token burst, a settled reply, a terminal settle, and an error.
handlers.get('session/event')({ id: childIds[0] }, {
  type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"src/http.js"}' },
})
handlers.get('agent/assistant-stream')({ agent: { id: childIds[0] }, frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', text: '接口已' } } })
handlers.get('agent/assistant-stream')({ agent: { id: childIds[0] }, frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: 2, chunk: { type: 'text-delta', text: '定稿。' } } })
handlers.get('session/event')({ id: childIds[0] }, {
  type: 'assistant/message', seq: 2,
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '接口已定稿。' }] }, usage: { inputTokens: 5, outputTokens: 7 } },
})
handlers.get('subagent/end')({ runId: 'r1', provider: 'spawn', id: childIds[1], local: true, stopReason: 'error', lastAssistantMessage: [] })

const snapshot = await host('state', { query: { sessionId } })
assert.equal(snapshot.status, 200)
const hostState = snapshot.payload.result

/* ------------------------------------------------------------------ *
 * Browser half, loaded exactly the way the shell loads it
 * ------------------------------------------------------------------ */

let definition
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  location: { origin: 'http://127.0.0.1:3080' },
}
globalThis.document = { documentElement: { lang: 'zh' } }
// `navigator` is a getter-only global in Node 22; the browser half only touches
// it inside a click handler, which this suite never reaches.

globalThis.window.__ModuleLoader__.load = value => { definition = value }
await import(new URL('../client.js', import.meta.url).href)

/** React stand-in: only shape matters, nothing renders here. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  useLayoutEffect: () => {},
}
/** Every primitive resolves to a dummy component, so a missing name is not the subject here. */
const primitivesStub = new Proxy({}, { get: () => function Primitive() { return null } })
const ALLOWED = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
const requireStub = (specifier) => {
  if (!ALLOWED.has(specifier)) throw new Error(`specifier outside the module table: ${specifier}`)
  if (specifier === 'react') return reactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  return {}
}

const client = definition.factory(requireStub)
const { helpers } = client

console.log('\n一半到另一半：宿主状态 → 浏览器状态')

await check('浏览器半能读懂宿主半的快照', () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  assert.equal(state.sessionId, sessionId)
  assert.equal(state.objective, '把构建迁移到 pnpm')
  assert.equal(state.agents.length, 2)
  assert.ok(state.feed.length > 0, 'the host board must carry feed items')
})
await check('宿主发出的每个 status 浏览器半都有色调与文案', () => {
  // The union the Host half can produce, spelled out here on purpose: adding a
  // status host-side without teaching the panel about it is exactly the break
  // this test exists to catch.
  const statuses = ['draft', 'queued', 'running', 'idle', 'done', 'error', 'stopped']
  for (const status of statuses) {
    const tone = helpers.statusTone(status)
    assert.ok(typeof tone === 'string' && tone !== '', `statusTone(${status}) must return a tone`)
    // The translate function here returns the key it was given, which proves the
    // panel asks for a label at all; that the key exists is the dictionary's job.
    const label = helpers.statusLabel(status, key => key)
    assert.ok(typeof label === 'string' && label !== '', `statusLabel(${status}) must resolve`)
  }
})
await check('每个宿主阶段的 phase 都能被浏览器半识别', () => {
  for (const phase of ['idle', 'planned', 'running', 'done']) {
    assert.equal(typeof helpers.phaseOf({ phase, agents: [] }), 'string')
  }
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  assert.ok(['idle', 'planned', 'running', 'done'].includes(helpers.phaseOf(state)))
})
await check('agent 帧（含 live 流式文本）能被覆盖式合并', () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  const card = { ...state.agents[0], status: 'running', live: '正在生成', activity: '正在生成回复' }
  const next = helpers.applyStreamEvent(state, 'agent', card)
  const merged = next.agents.find(agent => helpers.identityOf(agent) === helpers.identityOf(card))
  assert.equal(merged.live, '正在生成')
  assert.equal(merged.status, 'running')
  assert.equal(state.agents[0].live, '', 'merge must not mutate the previous state')
})
await check('host 的 live 字段确实非空时才会渲染', () => {
  // The Host keeps `live` empty between attempts; the panel branches on it, so a
  // host that stopped clearing it would show stale text forever.
  const streaming = hostState.agents[0]
  assert.equal(typeof streaming.live, 'string')
})
await check('每个宿主 status 都能落到一个分段样式（作曲栏指示器）', () => {
  // The composer strip renders one segment per agent, so a status the strip does
  // not classify would silently look "pending" — a settled agent whose segment
  // never fills. Only these four classes exist by design.
  const classes = new Set(['is-pending', 'is-running', 'is-done', 'is-failed'])
  for (const status of ['draft', 'queued', 'running', 'idle', 'done', 'error', 'stopped']) {
    const segment = helpers.segmentState({ status })
    assert.ok(classes.has(segment), `segmentState(${status}) returned ${String(segment)}`)
  }
  // The mapping must also be meaningful, not merely in-range: a settled agent
  // fills its segment, and a failed one must not read as success.
  assert.equal(helpers.segmentState({ status: 'done' }), 'is-done')
  assert.equal(helpers.segmentState({ status: 'error' }), 'is-failed')
  assert.equal(helpers.segmentState({ status: 'stopped' }), 'is-failed')
  assert.equal(helpers.segmentState({ status: 'running' }), 'is-running')
  assert.equal(helpers.segmentState({ status: 'idle' }), 'is-pending')
})
await check('feed 帧被追加且按 id 去重', () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  const item = { id: 'f999', time: Date.now(), kind: 'progress', from: 'x', fromName: 'X', to: '*', toName: '全体', agentId: null, text: '新进度' }
  const once = helpers.applyStreamEvent(state, 'feed', item)
  const twice = helpers.applyStreamEvent(once, 'feed', item)
  assert.equal(twice.feed.filter(entry => entry.id === 'f999').length, 1)
})
await check('board 与 heartbeat 帧不会破坏状态，未知事件原样返回', () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  const afterBoard = helpers.applyStreamEvent(state, 'board', { sessionId, objective: '改过的目标', phase: 'running' })
  assert.equal(afterBoard.objective, '改过的目标')
  assert.equal(afterBoard.agents.length, state.agents.length, 'a board frame must keep the roster')
  const afterHeartbeat = helpers.applyStreamEvent(state, 'heartbeat', { now: Date.now() })
  assert.equal(afterHeartbeat.agents.length, state.agents.length)
  assert.equal(helpers.applyStreamEvent(state, 'nonsense', {}), state)
})

console.log('\n另一半到这一半：浏览器载荷 → 宿主校验')

await check('浏览器半构造的 launch 载荷能被宿主半接受', async () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  const payload = helpers.launchPayload(state.objective, state.agents.map((card, index) => helpers.draftRowFromCard(card, index)))
  assert.ok(Array.isArray(payload.agents) && payload.agents.length === 2, 'the panel must send rows')
  const response = await host('launch', { method: 'POST', body: { op: 'launch', sessionId, ...payload } })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  assert.equal(response.payload.result.agents.length, 2)
})
await check('浏览器半的客户端校验与宿主半的校验不矛盾', async () => {
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', hostState)
  const rows = state.agents.map((card, index) => helpers.draftRowFromCard(card, index))
  const verdict = helpers.validateDraft(rows)
  assert.equal(verdict.ok, true, 'rows the host produced must pass the panel\'s own validation')
  const rejected = helpers.validateDraft(rows.map(row => ({ ...row, model: { provider: '', model: '' } })))
  assert.equal(rejected.ok, false, 'a row with no model must be refused before the round trip')
})
await check('浏览器半读得懂宿主半的 models 目录', async () => {
  const response = await host('models')
  assert.equal(response.status, 200)
  const entries = helpers.modelEntries(response.payload.result)
  assert.ok(Array.isArray(entries) && entries.length >= 1)
  assert.equal(entries[0].provider, 'deepseek-official')
})
await check('浏览器半能为宿主半的每个智能体构造合法的 steer 请求', async () => {
  // A fresh read, because the launch above replaced the roster: an id from a
  // superseded board is exactly what the Host half must refuse.
  const fresh = await host('state', { query: { sessionId } })
  const state = helpers.applyStreamEvent(helpers.emptyState(sessionId), 'snapshot', fresh.payload.result)
  const target = state.agents[0]
  const response = await host('steer', {
    method: 'POST',
    body: { op: 'steer', sessionId, agentId: helpers.identityOf(target), text: '先看 http.js', delivery: 'queue' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  assert.equal(promptCalls.at(-1).childSessionId, helpers.identityOf(target))
})
await check('过期智能体 id 会被宿主半拒绝而不是投错人', async () => {
  const response = await host('steer', {
    method: 'POST',
    body: { op: 'steer', sessionId, agentId: childIds[0], text: 'x' },
  })
  assert.equal(response.status, 404)
})

console.log('\n浏览器半的装载形态')

await check('插件对象的形状符合外壳要求', () => {
  assert.equal(definition.id, 'dsh-agent-hub')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
  for (const name of ['emptyState', 'applyStreamEvent', 'mergeAgent', 'draftFromState', 'validateDraft', 'newDraftRow', 'formatElapsed', 'formatTokens', 'statusTone', 'statusLabel', 'phaseOf', 'hostCall']) {
    assert.equal(typeof helpers[name], 'function', `helpers.${name} must be a function`)
  }
})
await check('模块表之外的 require 会失败（说明这份文件只依赖白名单）', () => {
  assert.throws(() => requireStub('@deepseek-ai/dsh-client-ui-session'), /outside the module table/)
})
await check('apply 注册四个槽位且不抛错（含拿不到 sessions 服务的部署）', () => {
  const registrations = []
  const slots = {
    inject(_key, callback) {
      const result = callback()
      if (result !== undefined && result !== null && typeof result[Symbol.iterator] === 'function') {
        for (const entry of result) void entry
      }
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const ctx = {
    slots,
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: (run) => { run() },
    get: () => undefined,
  }
  client.apply(ctx)
  const names = registrations.map(entry => entry.options.name).sort()
  assert.deepEqual(names, ['conversation.input.dock', 'conversation.view', 'main', 'sidebar.panellist'])
  const main = registrations.find(entry => entry.options.name === 'main')
  assert.equal(main.options.key, 'agent-hub')
  const sidebar = registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(sidebar.options.id, 'agent-hub', 'sidebar id must equal the main panel key')
})
await check('拿不到任何宿主服务时也能装载（ctx.get 对未声明服务是可选取值）', () => {
  const registrations = []
  const ctx = {
    slots: {
      inject(_key, callback) {
        const result = callback()
        if (result !== undefined && result !== null && typeof result[Symbol.iterator] === 'function') {
          for (const entry of result) void entry
        }
        return () => {}
      },
      register: (options) => { registrations.push(options); return () => {} },
    },
    // The real dynamic guard returns undefined for a service the plugin did not
    // declare, so that is the shape this test reproduces — an undeclared read
    // must degrade, never throw.
    get: () => undefined,
    on: () => () => {},
    effect: (run) => { run() },
  }
  client.apply(ctx)
  assert.equal(registrations.length, 4)
  const main = registrations.find(options => options.name === 'main')
  const injected = main.inject()
  assert.equal(typeof injected.t, 'function', 'the panel must always get a translate function')
  assert.equal(injected.sessionList, undefined, 'a missing session service surfaces as undefined, not a throw')
})

console.log('\n源码卫生')
await check('client.js 不含被 PowerShell 重编码过的中文', () => {
  const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
  const markers = ['鈥', '鍗', '锛', '鐨', '鏂', '浣', '鏄', '鍜', '鍦', '鍙', '缂', '璁', '绠']
  const hit = markers.find(marker => source.includes(marker))
  assert.equal(hit, undefined, `mojibake marker ${String(hit)} found in client.js`)
  assert.ok(!source.includes('\uFFFD'), 'client.js must not contain U+FFFD')
})
await check('client.js 不用 PowerShell 会毁掉的写入路径自证：文件是合法 UTF-8', () => {
  const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
  assert.ok(source.includes('协作台'), 'the panel title must be intact')
  assert.ok(source.includes('进度板'), 'the feed title must be intact')
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
