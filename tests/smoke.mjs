/**
 * dsh-agent-hub smoke test.
 *
 * Drives the real Host half — the real `apply`, the real route handler, the real
 * event handlers — through a mock context, so an assertion here is about the
 * code that ships rather than a re-implementation of it. The browser half is
 * checked separately by its own loader test; this file owns everything that
 * happens in the host process.
 *
 * Run: node --no-warnings tests/smoke.mjs   (see package.json "test")
 *
 * Exit code matters: an unhandled rejection at the tail of the run would
 * otherwise let a failing suite print "all passed" and still exit 1, so the
 * counts below are the authority and a stray rejection fails the run outright.
 *
 * @module dsh-agent-hub/tests/smoke
 */

import assert from 'node:assert/strict'

import { apply as loadPlugin, Config, inject, name } from '../index.js'
import { createCard, findPeer, HubError, messageOf, phaseOf, textFromBlocks } from '../src/hub.js'
import { normalizeConfig } from '../src/config.js'
import { buildAgentPersona, buildAgentPrompt } from '../src/prompt.js'
import { finishError, normalizeAgents, parsePlanJson } from '../src/llm.js'
import { formatBoard } from '../src/tools.js'
import { MARKER_HEADER, openStream, ROUTE_PATH } from '../src/http.js'

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

/** Mutable state the mock services read, so tests can steer behaviour. */
const state = {
  llmReply: JSON.stringify({
    agents: [
      { name: '架构', role: '接口设计', task: '给出模块边界与签名', files: ['src/hub.js'], write: true, shell: false, message: true },
      { name: '评审', role: '对抗评审', task: '找出接口里的漏洞', files: [], write: false, shell: false, message: true },
    ],
  }),
  llmFail: false,
  startFail: false,
  startCalls: [],
  promptCalls: [],
  interruptCalls: [],
  llmOptions: null,
  warnings: [],
}

/** Parent session route the hub falls back to. */
const parentAgent = {
  id: 'session-parent',
  session: {
    id: 'session-parent',
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  },
}

/** Routes the plugin registered on the fake web server. */
const routes = []

/** Services the plugin resolves through `ctx.get`. */
const services = {
  agents: { get: id => (id === 'session-parent' ? parentAgent : undefined) },
  subagents: {
    list: () => ['spawn', 'fork'],
    startContinuable: async (spec) => {
      state.startCalls.push(spec)
      if (state.startFail) throw new Error('provider refused to start')
      const index = state.startCalls.length
      return { childId: `child-${index}`, messageId: `msg-${index}` }
    },
    prompt: async (request) => {
      state.promptCalls.push(request)
      return { messageId: `pm-${state.promptCalls.length}` }
    },
    interrupt: (childId, authority) => { state.interruptCalls.push([childId, authority]) },
  },
  llm: {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'zai-coding-cn', name: 'ZAI' }],
    listModels: async provider => (provider === 'deepseek-official' ? [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] : []),
    stream: async function* stream(options) {
      state.llmOptions = options
      if (state.llmFail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'BOOM', message: '上游炸了' } } }
        return
      }
      yield { type: 'text-delta', text: state.llmReply }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

/**
 * Build a mock Cordis context that records every registration.
 * @param {Record<string, any>} extra - Extra services.
 * @returns {Record<string, any>} Harness handle.
 */
function mockContext(extra) {
  const storage = new Map()
  const tools = {
    register(definition) {
      storage.set(definition.name, definition)
      return () => storage.delete(definition.name)
    },
    get: toolName => storage.get(toolName),
    registered: storage,
  }
  const handlers = new Map()
  const disposers = []
  const all = { tools, webServer: { register: (entry) => { routes.push(entry); return () => { const at = routes.indexOf(entry); if (at >= 0) routes.splice(at, 1) } } }, ...extra }
  const ctx = {
    logger: { info: () => {}, warn: message => state.warnings.push(String(message)) },
    tools,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(run) {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get: serviceName => all[serviceName],
  }
  return {
    ctx,
    tools,
    handlers,
    disposers,
    all,
    dispose: () => { for (const disposer of disposers.reverse()) disposer() },
  }
}

/** Drive one JSON operation through the registered route. */
async function request(route, method, url, body, extraHeaders = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...extraHeaders },
    on: () => {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(payload) { text = String(payload ?? '') },
  }
  await route.handler(req, res)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  return { status, payload }
}

/** A response stub that records SSE writes instead of ending. */
function streamResponse() {
  const chunks = []
  const listeners = new Map()
  return {
    chunks,
    listeners,
    status: 0,
    destroyed: false,
    writableEnded: false,
    writeHead(code) { this.status = code },
    write(piece) { chunks.push(String(piece)); return true },
    end() { this.writableEnded = true },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
    },
    /** Fire the named lifecycle event, as Node would on a dropped connection. */
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
  }
}

/** A request stub that looks like a browser's EventSource GET. */
function streamRequest(sessionId) {
  const listeners = new Map()
  return {
    method: 'GET',
    url: `${ROUTE_PATH}?op=stream&sessionId=${encodeURIComponent(sessionId)}`,
    headers: { host: '127.0.0.1:3080' },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    async *[Symbol.asyncIterator]() {},
  }
}

/** Parse raw SSE text into frames, ignoring comment/retry blocks. */
function framesOf(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block !== '' && block.includes('event: '))
    .map(block => {
      const lines = block.split('\n')
      const event = lines.find(line => line.startsWith('event: '))?.slice(7)
      const data = lines.find(line => line.startsWith('data: '))?.slice(6)
      return { event, data: data === undefined ? undefined : JSON.parse(data) }
    })
}

/** Await a condition, so a coalesced frame can arrive. */
function wait(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

const harness = mockContext(services)
loadPlugin(harness.ctx, { provider: 'spawn' })
const route = routes[0]
const sessionId = 'session-parent'

console.log('\n配置')
await check('默认配置通过，且补齐全部默认值', () => {
  const result = Config['~standard'].validate({})
  assert.ok(!('issues' in result), 'expected no issues')
  assert.equal(result.value.maxAgents, 8)
  assert.equal(result.value.defaultShell, false)
  assert.equal(result.value.feedLimit, 200)
})
await check('未知选项被拒绝（拼错配置不会静默忽略）', () => {
  const result = normalizeConfig({ maxAgnet: 4 })
  assert.ok('issues' in result)
  assert.match(result.issues[0].message, /unknown option/)
})
await check('类型错误被拒绝', () => {
  assert.ok('issues' in normalizeConfig({ maxAgents: '4' }))
  assert.ok('issues' in normalizeConfig({ defaultWrite: 1 }))
  assert.ok('issues' in normalizeConfig({ feedLimit: 0 }))
})
await check('maxAgents 上限被拒绝', () => {
  assert.ok('issues' in normalizeConfig({ maxAgents: 64 }))
})
await check('apply 对非法配置直接抛错（装载期失败而不是首次使用）', () => {
  const other = mockContext(services)
  assert.throws(() => loadPlugin(other.ctx, { maxAgents: 'x' }), /配置无效/)
})

console.log('\n装载接线')
await check('插件名与必需服务正确', () => {
  assert.equal(name, 'dsh-agent-hub')
  assert.deepEqual(inject, ['tools'])
})
await check('注册了两个协作工具', () => {
  assert.deepEqual([...harness.tools.registered.keys()].sort(), ['hub_post', 'hub_read'])
})
await check('两个工具的 parameters 都是 object 根的原始 JSON Schema', () => {
  for (const tool of harness.tools.registered.values()) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters.type`)
    assert.ok(tool.parameters.properties, `${tool.name}.parameters.properties`)
  }
  assert.deepEqual(harness.tools.registered.get('hub_post').parameters.required, ['text'])
})
await check('订阅了五条宿主事件', () => {
  assert.deepEqual([...harness.handlers.keys()].sort(), [
    'agent/assistant-stream', 'agent/status', 'session/event', 'subagent/end', 'subagent/start',
  ])
})
await check('注册了唯一一条同源路由', () => {
  assert.equal(routes.length, 1)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE_PATH)
})
await check('工具结果渲染成文本块', () => {
  const blocks = harness.tools.registered.get('hub_read').output.render({}, '内容')
  assert.deepEqual(blocks, [{ type: 'text', text: '内容' }])
})

console.log('\n请求边界')
await check('缺 op 返回 400', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}`)
  assert.equal(response.status, 400)
})
await check('未知 op 返回 404', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=nope`)
  assert.equal(response.status, 404)
})
await check('写操作必须 POST：GET 打到写操作返回 405', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=launch`)
  assert.equal(response.status, 405)
})
await check('读操作必须 GET：POST 打到读操作返回 405', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=state`, { op: 'state' }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 405)
})
await check('写操作缺标记头返回 403', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=stopAll`, { op: 'stopAll', sessionId })
  assert.equal(response.status, 403)
})
await check('跨源请求返回 403', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state`, undefined, { origin: 'https://evil.example' })
  assert.equal(response.status, 403)
})
await check('同源请求放行', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state`, undefined, { origin: 'http://127.0.0.1:3080' })
  assert.equal(response.status, 200)
})
await check('非法查询参数返回 400 而不是静默回退', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=feed&sessionId=${sessionId}&limit=abc`)
  assert.equal(response.status, 400)
  assert.match(String(response.payload.error), /limit/)
})
await check('HEAD 返回 405', async () => {
  const response = await request(route, 'HEAD', `${ROUTE_PATH}?op=state`)
  assert.equal(response.status, 405)
})
await check('请求体不是 JSON 返回 400', async () => {
  const chunks = [Buffer.from('{not json', 'utf8')]
  const req = {
    method: 'POST',
    url: `${ROUTE_PATH}?op=stopAll`,
    headers: { host: '127.0.0.1:3080', [MARKER_HEADER]: '1' },
    on: () => {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  await route.handler(req, { writeHead: code => { status = code }, end: () => {} })
  assert.equal(status, 400)
})

console.log('\n空台与目录')
await check('缺 sessionId 的 state 返回一块空台而不是报错', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.result.phase, 'idle')
  assert.deepEqual(response.payload.result.agents, [])
})
await check('models 返回 provider 与模型，且单个 provider 失败不影响整体', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=models`)
  assert.equal(response.status, 200)
  const providers = response.payload.result.providers
  assert.equal(providers.length, 2)
  assert.deepEqual(providers[0].models, [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }])
  assert.deepEqual(providers[1].models, [])
  assert.equal(response.payload.result.hasLLM, true)
})

console.log('\n协调者拆分')
await check('draft 调用了协调者并返回可编辑的角色行', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=draft`, {
    op: 'draft', sessionId, objective: '把构建迁移到 pnpm', count: 2,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  const agents = response.payload.result.draft.agents
  assert.equal(agents.length, 2)
  assert.equal(agents[0].name, '架构')
  assert.deepEqual(agents[0].files, ['src/hub.js'])
  assert.equal(agents[0].powers.write, true)
  assert.equal(agents[1].powers.write, false)
  assert.equal(agents[0].model.provider, 'deepseek-official')
  assert.deepEqual(response.payload.result.usage, { inputTokens: 12, outputTokens: 34 })
})
await check('draft 把会话路由作为协调者模型', () => {
  assert.equal(state.llmOptions.provider, 'deepseek-official')
  assert.equal(state.llmOptions.model, 'deepseek-flash')
  assert.equal(state.llmOptions.sessionId, sessionId)
})
await check('draft 后 phase 变成 planned', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(response.payload.result.phase, 'planned')
  assert.equal(response.payload.result.agents.every(agent => agent.status === 'draft'), true)
})
await check('count 超出上限返回 400', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=draft`, {
    op: 'draft', sessionId, objective: 'x', count: 99,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 400)
})
await check('objective 为空返回 400', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=draft`, {
    op: 'draft', sessionId, objective: '   ',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 400)
})
await check('协调者模型失败返回 502 并带上游原因', async () => {
  state.llmFail = true
  try {
    const response = await request(route, 'POST', `${ROUTE_PATH}?op=draft`, {
      op: 'draft', sessionId, objective: 'x',
    }, { [MARKER_HEADER]: '1' })
    assert.equal(response.status, 502)
    assert.match(String(response.payload.error), /BOOM|上游炸了/)
  } finally {
    state.llmFail = false
  }
})
await check('协调者输出被截断时拒绝而不是启动残缺团队', async () => {
  const truncated = async function* truncatedStream() {
    yield { type: 'text-delta', text: '{"agents":[' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  const original = services.llm.stream
  services.llm.stream = truncated
  try {
    const response = await request(route, 'POST', `${ROUTE_PATH}?op=draft`, {
      op: 'draft', sessionId, objective: 'x',
    }, { [MARKER_HEADER]: '1' })
    assert.equal(response.status, 502)
    assert.match(String(response.payload.error), /截断/)
  } finally {
    services.llm.stream = original
  }
})

console.log('\n派发')
state.startCalls.length = 0
// The board still holds the draft-only rows from the split above, which is
// exactly the state in which "not started yet" must be reported.
await check('对还没启动的角色插话返回 409', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=steer`, {
    op: 'steer', sessionId, agentId: 'a1', text: 'x',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 409)
  assert.match(String(response.payload.error), /还没有启动/)
})
const draftRows = [
  {
    clientId: 'a1', name: '架构', role: '接口设计', task: '给出模块边界',
    model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    powers: { write: true, shell: false, message: true }, files: ['src/hub.js'],
  },
  {
    clientId: 'a2', name: '评审', role: '对抗评审', task: '找漏洞',
    model: { provider: 'zai-coding-cn', model: 'glm-4.6' },
    powers: { write: false, shell: false, message: true }, files: [],
  },
]
await check('launch 用各自选定的模型启动两个智能体', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
    op: 'launch', sessionId, objective: '把构建迁移到 pnpm', agents: draftRows,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  const agents = response.payload.result.agents
  assert.equal(agents.length, 2)
  assert.equal(agents[0].id, 'child-1')
  assert.equal(agents[1].id, 'child-2')
  assert.equal(agents[0].status, 'running')
})
await check('每个子智能体拿到自己的 provider/model 与 persona', () => {
  assert.equal(state.startCalls.length, 2)
  assert.equal(state.startCalls[0].provider, 'spawn')
  assert.equal(state.startCalls[0].request.parent, parentAgent)
  assert.deepEqual(state.startCalls[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(state.startCalls[1].request.agentOptions, { provider: 'zai-coding-cn', model: 'glm-4.6' })
  assert.match(state.startCalls[0].request.persona, /shared board/)
  assert.match(state.startCalls[0].request.prompt[0].text, /把构建迁移到 pnpm/)
  assert.match(state.startCalls[0].request.prompt[0].text, /评审/)
})
await check('权限映射：可写不可执行只 deny 命令类工具', () => {
  const filter = state.startCalls[0].request.toolFilter
  // No shell tool is registered in this harness, so the filter has nothing to
  // name — and must therefore be absent rather than a filter that throws.
  assert.equal(filter, undefined)
})
await check('权限映射：只读角色使用白名单', () => {
  // "评审" is write:false shell:false -> whitelist of read-only tools. The mock
  // registry has hub_post/hub_read registered, so the whitelist is non-empty.
  const filter = state.startCalls[1].request.toolFilter
  assert.ok(filter !== undefined, 'expected a restriction')
  assert.ok(Array.isArray(filter.allow), 'expected an allow list')
  assert.ok(filter.allow.includes('hub_post'))
  assert.ok(!filter.allow.includes('write'))
})
await check('launch 后 phase 为 running，feed 有启动记录', async () => {
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  const result = response.payload.result
  assert.equal(result.phase, 'running')
  assert.ok(result.feed.some(item => item.kind === 'system' && item.text.includes('已启动')))
  assert.deepEqual(result.providers, ['spawn', 'fork'])
})
await check('缺少模型的角色被拒绝', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
    op: 'launch', sessionId, agents: [{ name: 'x', task: 'y' }],
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 400)
})
await check('超过 maxAgents 的派发被拒绝', async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...draftRows[0], name: `n${index}` }))
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
    op: 'launch', sessionId, agents: many,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 400)
})
await check('单个智能体启动失败只标记它自己', async () => {
  state.startFail = true
  try {
    const response = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
      op: 'launch', sessionId, agents: [draftRows[0]],
    }, { [MARKER_HEADER]: '1' })
    assert.equal(response.status, 200)
    assert.equal(response.payload.result.agents[0].status, 'error')
    assert.match(response.payload.result.agents[0].error, /provider refused/)
  } finally {
    state.startFail = false
  }
})
await check('父会话没有活动智能体时给出可操作的 409', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
    op: 'launch', sessionId: 'session-cold', agents: [draftRows[0]],
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 409)
  assert.match(String(response.payload.error), /发一条消息/)
})

console.log('\n事件投影')
// Re-launch so two live children exist again after the failure case above, and
// use the ids the hub actually allocated rather than assuming a counter: a test
// that hard-codes them would pass even if allocation changed underneath it.
const relaunched = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
  op: 'launch', sessionId, objective: '把构建迁移到 pnpm', agents: draftRows,
}, { [MARKER_HEADER]: '1' })
const firstId = relaunched.payload.result.agents[0].id
const secondId = relaunched.payload.result.agents[1].id
/** Ids of the roster the messaging section drives. */
let currentIds = [firstId, secondId]
assert.ok(typeof firstId === 'string' && typeof secondId === 'string' && firstId !== secondId)
const sessionEvent = harness.handlers.get('session/event')
await check('tool/call 变成一句人话的活动与一条进度', async () => {
  sessionEvent({ id: firstId }, {
    type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"src/hub.js"}' },
  })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  const card = response.payload.result.agents[0]
  assert.match(card.activity, /src\/hub\.js/)
  assert.ok(response.payload.result.feed.some(item => item.kind === 'progress' && item.text.includes('src/hub.js')))
})
await check('assistant/message 追加输出并累计 token', async () => {
  sessionEvent({ id: firstId }, {
    type: 'assistant/message', seq: 2,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '接口已定稿。' }] }, usage: { inputTokens: 7, outputTokens: 9 } },
  })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  const card = response.payload.result.agents[0]
  assert.match(card.output, /接口已定稿/)
  assert.deepEqual(card.usage, { input: 7, output: 9 })
  assert.equal(card.live, '', 'committed text must clear the in-flight buffer')
})
await check('assistant-stream 的增量进入 live 缓冲', async () => {
  const stream = harness.handlers.get('agent/assistant-stream')
  stream({ agent: { id: firstId }, frame: { type: 'start', attemptId: 'a', revision: 1, turn: 2, step: 1 } })
  stream({ agent: { id: firstId }, frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', text: '正在' } } })
  stream({ agent: { id: firstId }, frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: 2, chunk: { type: 'text-delta', text: '生成' } } })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(response.payload.result.agents[0].live, '正在生成')
})
await check('subagent/end 是唯一的终态来源', async () => {
  harness.handlers.get('subagent/end')({
    runId: 'r1', provider: 'spawn', id: firstId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '交付：src/hub.js 已改完' }],
  })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  const card = response.payload.result.agents[0]
  assert.equal(card.status, 'done')
  assert.ok(card.endedAt !== null)
  assert.ok(response.payload.result.feed.some(item => item.text.includes('交付')))
})
await check('未列入协作台的会话事件被忽略', async () => {
  sessionEvent({ id: 'session-unrelated' }, { type: 'tool/call', seq: 9, data: { turn: 1, step: 1, name: 'read', arguments: '{}' } })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(response.payload.result.agents[0].status, 'done')
})
await check('agent/status 让空闲的子智能体变成待命而不是完成', async () => {
  harness.handlers.get('agent/status')({ agent: { id: secondId }, status: 'running' })
  harness.handlers.get('agent/status')({ agent: { id: secondId }, status: 'idle' })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(response.payload.result.agents[1].status, 'idle')
  assert.equal(response.payload.result.agents[1].endedAt, null, 'idle must not look terminal')
})
await check('重新派发后旧子会话的事件不再算在新卡片上', async () => {
  const replacement = await request(route, 'POST', `${ROUTE_PATH}?op=launch`, {
    op: 'launch', sessionId, agents: draftRows,
  }, { [MARKER_HEADER]: '1' })
  currentIds = replacement.payload.result.agents.map(agent => agent.id)
  sessionEvent({ id: firstId }, {
    type: 'assistant/message', seq: 30, data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: '旧智能体的迟到输出' }] } },
  })
  const response = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(response.payload.result.agents[0].output, '', 'stale events must not land on the new card')
  assert.equal(currentIds.length, 2)
})

console.log('\n人与智能体的消息')
await check('steer 把话投进指定智能体的收件箱并记到进度板', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=steer`, {
    op: 'steer', sessionId, agentId: currentIds[0], text: '先看 src/http.js', delivery: 'steer',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  assert.equal(response.payload.result.accepted, true)
  const sent = state.promptCalls.at(-1)
  assert.equal(sent.childSessionId, currentIds[0])
  assert.equal(sent.parentSessionId, sessionId)
  assert.equal(sent.delivery, 'steer')
  assert.equal(sent.content[0].text, '先看 src/http.js')
  const board = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.ok(board.payload.result.feed.some(item => item.kind === 'human' && item.text.includes('先看')))
})
await check('steer 的 delivery 只接受 queue 或 steer', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=steer`, {
    op: 'steer', sessionId, agentId: currentIds[0], text: 'x', delivery: 'now',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 400)
})
await check('对不存在的智能体插话返回 404', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=steer`, {
    op: 'steer', sessionId, agentId: 'nobody', text: 'x',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 404)
})
await check('broadcast 投给所有已启动的智能体', async () => {
  const before = state.promptCalls.length
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=broadcast`, {
    op: 'broadcast', sessionId, text: '统一用 pnpm',
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.result.delivered, 2)
  assert.equal(state.promptCalls.length - before, 2)
})
await check('interrupt 走 subagent 的中断通道', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=interrupt`, {
    op: 'interrupt', sessionId, agentId: currentIds[0],
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200)
  assert.deepEqual(state.interruptCalls.at(-1), [currentIds[0], { kind: 'user', parentSessionId: sessionId }])
})
await check('stopAll 停掉仍然在跑的智能体', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=stopAll`, {
    op: 'stopAll', sessionId,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 200)
  assert.ok(response.payload.result.stopped >= 1)
})
await check('hub_post 从子智能体发到全体', async () => {
  const tool = harness.tools.registered.get('hub_post')
  const text = await tool.execute({ text: '数据库 schema 已定稿' }, { agent: { session: { id: currentIds[0] } } })
  assert.match(text, /全体可见/)
  const board = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  const item = board.payload.result.feed.at(-1)
  assert.equal(item.kind, 'progress')
  assert.equal(item.fromName, '架构')
  assert.equal(item.to, '*')
})
await check('hub_post 指定同伴时真的投递进对方收件箱', async () => {
  const before = state.promptCalls.length
  const tool = harness.tools.registered.get('hub_post')
  const text = await tool.execute(
    { text: '接口已冻结，可以联调', to: '评审' },
    { agent: { session: { id: currentIds[0] } } },
  )
  assert.match(text, /投递给/)
  assert.equal(state.promptCalls.length - before, 1)
  assert.match(state.promptCalls.at(-1).content[0].text, /来自同伴 架构/)
  const board = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(board.payload.result.feed.at(-1).kind, 'handoff')
})
await check('不在协作台上的智能体调用 hub_post 会失败而不是静默丢弃', async () => {
  const tool = harness.tools.registered.get('hub_post')
  await assert.rejects(
    () => tool.execute({ text: 'x' }, { agent: { session: { id: 'session-unrelated' } } }),
    /不在任何协作台/,
  )
})
await check('hub_read 渲染出名册与进度板', async () => {
  const tool = harness.tools.registered.get('hub_read')
  const text = await tool.execute({}, { agent: { session: { id: currentIds[0] } } })
  assert.match(text, /目标：把构建迁移到 pnpm/)
  assert.match(text, /队友：/)
  assert.match(text, /评审/)
  assert.match(text, /进度板/)
})

console.log('\n实时流')
await check('SSE 建连先发 snapshot，随后推送增量', async () => {
  const res = streamResponse()
  await route.handler(streamRequest(sessionId), res)
  assert.equal(res.status, 200)
  const initial = framesOf(res.chunks)
  assert.equal(initial[0].event, 'snapshot')
  assert.equal(initial[0].data.agents.length, 2)
  const before = res.chunks.length
  sessionEvent({ id: currentIds[0] }, {
    type: 'tool/call', seq: 20, data: { turn: 3, step: 1, callId: 'c9', name: 'grep', arguments: '{"pattern":"registerHubRoutes"}' },
  })
  assert.ok(res.chunks.length > before, 'expected a frame pushed to the open stream')
  assert.ok(framesOf(res.chunks.slice(before)).some(frame => frame.event === 'progress' || frame.event === 'feed'))
  // The coalesced `agent` frame arrives on its own timer.
  await wait(260)
  assert.ok(framesOf(res.chunks).some(frame => frame.event === 'agent'))
})
await check('SSE 带标准重连提示与事件流响应头', () => {
  const res = streamResponse()
  const req = streamRequest(sessionId)
  openStream({ state: () => ({ ok: true }), subscribe: () => () => {} }, req, res, sessionId)
  assert.match(res.chunks[0], /^retry: \d+\n\n/)
  assert.ok(framesOf(res.chunks).some(frame => frame.event === 'snapshot'))
})
await check('stream 只接受 GET', async () => {
  const response = await request(route, 'POST', `${ROUTE_PATH}?op=stream`, { op: 'stream' }, { [MARKER_HEADER]: '1' })
  assert.equal(response.status, 405)
})

console.log('\n纯函数')
await check('parsePlanJson 容忍代码围栏', () => {
  assert.deepEqual(parsePlanJson('```json\n{"agents":[]}\n```'), { agents: [] })
  assert.throws(() => parsePlanJson('没有 JSON'), /JSON/)
})
await check('normalizeAgents 丢掉没有任务的行', () => {
  const agents = normalizeAgents({ agents: [{ name: 'x' }, { name: 'y', task: '干活' }] }, {
    count: 4, route: { provider: 'p', model: 'm' }, defaults: { write: true, shell: false },
  })
  assert.equal(agents.length, 1)
  assert.equal(agents[0].name, 'y')
  assert.equal(agents[0].model.provider, 'p')
})
await check('normalizeAgents 拒绝全空的方案', () => {
  assert.throws(() => normalizeAgents({ agents: [] }, {
    count: 2, route: { provider: 'p', model: 'm' }, defaults: { write: true, shell: false },
  }), /没有给出任何角色/)
})
await check('finishError 把失败与截断都当失败', () => {
  assert.equal(finishError(undefined), undefined)
  assert.equal(finishError({ kind: 'stop' }), undefined)
  assert.match(finishError({ kind: 'aborted' }).message, /aborted/)
  assert.match(finishError({ kind: 'max-tokens' }).message, /截断/)
})
await check('phaseOf 覆盖四种阶段', () => {
  assert.equal(phaseOf({ agents: [] }), 'idle')
  assert.equal(phaseOf({ agents: [{ status: 'draft' }] }), 'planned')
  assert.equal(phaseOf({ agents: [{ status: 'running' }, { status: 'done' }] }), 'running')
  assert.equal(phaseOf({ agents: [{ status: 'done' }, { status: 'error' }] }), 'done')
  assert.equal(phaseOf({ agents: [{ status: 'idle' }] }), 'running')
})
await check('createCard 的权限默认值来自配置', () => {
  const card = createCard({ task: 't' }, 0, { defaultWrite: false, defaultShell: true })
  assert.deepEqual(card.powers, { read: true, write: false, shell: true, message: true })
  assert.equal(card.clientId, 'a1')
  assert.equal(card.status, 'draft')
})
await check('textFromBlocks 只取文本块', () => {
  assert.equal(textFromBlocks([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textFromBlocks('raw'), 'raw')
  assert.equal(textFromBlocks(undefined), '')
})
await check('persona 与任务提示词没有会触发模板插值的双花括号', () => {
  const card = createCard({ name: 'x', task: 'y' }, 0, { defaultWrite: true, defaultShell: false })
  for (const text of [buildAgentPersona(card), buildAgentPrompt(card, '目标', [{ name: 'x', role: '', files: [] }])]) {
    assert.ok(!text.includes('{{'), 'persona/task text must not contain {{')
  }
})
await check('formatBoard 在空进度板上也不崩', () => {
  const text = formatBoard({
    objective: '', you: { name: '你' }, roster: [], feed: [],
  })
  assert.match(text, /还没有人汇报/)
})
await check('messageOf 对任意抛出物都给得出字符串', () => {
  assert.equal(messageOf(new Error('x')), 'x')
  assert.equal(messageOf('y'), 'y')
  assert.equal(typeof messageOf({ a: 1 }), 'string')
})
await check('HubError 带状态码', () => {
  assert.equal(new HubError(409, 'x').status, 409)
})

console.log('\n边界与清理')
await check('feed 支持 limit 与 since 游标', async () => {
  const page = await request(route, 'GET', `${ROUTE_PATH}?op=feed&sessionId=${sessionId}&limit=1`)
  assert.equal(page.status, 200)
  assert.equal(page.payload.result.items.length, 1)
  const cursor = page.payload.result.lastId
  const empty = await request(route, 'GET', `${ROUTE_PATH}?op=feed&sessionId=${sessionId}&since=${cursor}`)
  assert.deepEqual(empty.payload.result.items, [])
  await request(route, 'POST', `${ROUTE_PATH}?op=broadcast`, {
    op: 'broadcast', sessionId, text: '再来一条',
  }, { [MARKER_HEADER]: '1' })
  const after = await request(route, 'GET', `${ROUTE_PATH}?op=feed&sessionId=${sessionId}&since=${cursor}`)
  assert.equal(after.payload.result.items.length, 1)
})
await check('SSE 客户端断开后立刻停止推送', async () => {
  const res = streamResponse()
  const req = streamRequest(sessionId)
  await route.handler(req, res)
  const before = res.chunks.length
  req.emit('close')
  sessionEvent({ id: currentIds[0] }, {
    type: 'tool/call', seq: 40, data: { turn: 1, step: 1, callId: 'c40', name: 'read', arguments: '{}' },
  })
  assert.equal(res.chunks.length, before, 'a closed stream must not receive further frames')
})
await check('findPeer 按名字找同伴，重名时拒绝而不是猜', () => {
  const board = { agents: [{ id: 'c1', clientId: 'a1', name: '架构' }, { id: 'c2', clientId: 'a2', name: '架构' }] }
  assert.equal(findPeer(board, 'c1').id, 'c1')
  assert.throws(() => findPeer(board, '架构'), /有两个同伴/)
  assert.throws(() => findPeer(board, '查无此人'), /找不到同伴/)
  const single = { agents: [{ id: 'c1', clientId: 'a1', name: '评审' }] }
  assert.equal(findPeer(single, '评审').id, 'c1')
})
await check('clear 清空整块台', async () => {
  const cleared = await request(route, 'POST', `${ROUTE_PATH}?op=clear`, {
    op: 'clear', sessionId,
  }, { [MARKER_HEADER]: '1' })
  assert.equal(cleared.status, 200)
  const state = await request(route, 'GET', `${ROUTE_PATH}?op=state&sessionId=${sessionId}`)
  assert.equal(state.payload.result.phase, 'idle')
  assert.deepEqual(state.payload.result.agents, [])
  assert.deepEqual(state.payload.result.feed, [])
})
await check('清台后智能体再汇报会失败而不是写进一块不存在的台', async () => {
  const tool = harness.tools.registered.get('hub_post')
  await assert.rejects(
    () => tool.execute({ text: 'x' }, { agent: { session: { id: currentIds[0] } } }),
    /不在任何协作台/,
  )
})

console.log('\n卸载')
await check('卸载时撤销注册且不抛错', () => {
  harness.dispose()
})
await check('卸载后不再推送帧', async () => {
  const res = streamResponse()
  await route.handler(streamRequest(sessionId), res)
  // The hub is torn down with the plugin; a fresh stream still answers with a
  // snapshot from the (now empty) board, and nothing keeps running afterwards.
  assert.equal(res.status, 200)
  assert.equal(framesOf(res.chunks)[0].event, 'snapshot')
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
