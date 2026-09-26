/**
 * The hub's same-origin HTTP surface: one route, a dozen operations, and the
 * live stream the panel subscribes to.
 *
 * An out-of-tree plugin cannot mount a Typert Remote namespace — that would
 * require taking part in the harness's Client assembly build — so the browser
 * half talks to its own Host half over a route this plugin owns. Three
 * consequences, each handled explicitly below:
 *
 * 1. **The operation, not the HTTP method, decides whether a call mutates.**
 *    `?op=` is caller-chosen, so a `GET` must never be able to reach a write:
 *    reads are GET-only, writes are POST-only, and everything else is a 405.
 * 2. **Query and body values are strings of unknown type.** Every field is
 *    parsed and range-checked; an invalid value is a 400, never a silent
 *    fallback to a default (a silent fallback once turned "300 entries" into
 *    "100 entries" with no error anywhere).
 * 3. **A cross-site page must not be able to drive the board.** `Origin` is
 *    checked against `Host`, and mutations additionally require a custom
 *    marker header that a cross-site form cannot send.
 *
 * The marker header is a CSRF guard, not authentication: it proves nothing
 * about who is calling, only that the caller could set a header.
 *
 * @module dsh-agent-hub/src/http
 */

import { HubError, messageOf } from './hub.js'

/** Route path the browser half calls. */
export const ROUTE_PATH = '/agent-hub'
/** Custom header required on mutations. */
export const MARKER_HEADER = 'x-dsh-agent-hub'
/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 256 * 1024
/** How often the stream sends a comment-free heartbeat, in milliseconds. */
const HEARTBEAT_MS = 15000

/**
 * One operation: whether it mutates, and how it runs.
 *
 * `write: true` entries are reachable only through POST. Keeping this table in
 * one place is what makes the method check exhaustive rather than a property of
 * each handler's discipline.
 */
const OPERATIONS = {
  state: { write: false, run: (hub, input) => hub.state(input.sessionId ?? '') },
  models: { write: false, run: hub => hub.catalog() },
  feed: {
    write: false,
    run: (hub, input) => hub.feed(input.sessionId ?? '', { since: input.since, limit: input.limit }),
  },
  draft: {
    write: true,
    run: (hub, input, signal) => hub.draft(requireSession(input), {
      objective: requireText(input.objective, 'objective'),
      // Validated here rather than clamped inside the hub: a caller that asked
      // for 99 agents gets a 400, not a quiet 8.
      count: optionalCount(input.count, 'count'),
      models: requireStringArray(input.models, 'models'),
      coordinator: input.coordinator,
      signal,
    }),
  },
  launch: {
    write: true,
    run: (hub, input, signal) => hub.launch(requireSession(input), {
      objective: input.objective,
      agents: requireArray(input.agents, 'agents'),
      models: requireStringArray(input.models, 'models'),
      signal,
    }),
  },
  steer: {
    write: true,
    run: (hub, input, signal) => hub.steer(requireSession(input), {
      agentId: requireText(input.agentId, 'agentId'),
      text: requireText(input.text, 'text'),
      delivery: requireEnum(input.delivery, 'delivery', ['queue', 'steer']),
      signal,
    }),
  },
  broadcast: {
    write: true,
    run: (hub, input, signal) => hub.broadcast(requireSession(input), {
      text: requireText(input.text, 'text'),
      to: requireStringArray(input.to, 'to'),
      signal,
    }),
  },
  interrupt: {
    write: true,
    run: (hub, input) => hub.interrupt(requireSession(input), {
      agentId: requireText(input.agentId, 'agentId'),
    }),
  },
  'agent.wake': {
    write: true,
    run: (hub, input, signal) => hub.wake(requireSession(input), {
      agentId: requireText(input.agentId, 'agentId'),
      text: optionalText(input.text, 'text'),
      signal,
    }),
  },
  stopAll: { write: true, run: (hub, input) => hub.stopAll(requireSession(input)) },
  clear: { write: true, run: (hub, input) => hub.clear(requireSession(input)) },
}

/** The stream is a read, but it is not an envelope response. */
const STREAM_OP = 'stream'

/**
 * Require a non-empty session id.
 * @param {Record<string, any>} input - Parsed input.
 * @returns {string} The session id.
 * @throws {HubError} 400 when absent.
 */
function requireSession(input) {
  const value = input.sessionId
  if (typeof value !== 'string' || value.trim() === '') throw new HubError(400, 'sessionId 不能为空')
  return value.trim()
}

/**
 * Require a non-empty string field.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @returns {string} The trimmed value.
 * @throws {HubError} 400 when absent or the wrong type.
 */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new HubError(400, `${name} 不能为空`)
  return value.trim()
}

/**
 * Accept an optional string field.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @returns {string|undefined} The trimmed value, or undefined when absent.
 * @throws {HubError} 400 when present with the wrong type.
 */
function optionalText(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HubError(400, `${name} 必须是字符串`)
  return value.trim()
}

/**
 * Require an array field.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @returns {any[]} The array.
 * @throws {HubError} 400 when absent or the wrong type.
 */
function requireArray(value, name) {
  if (!Array.isArray(value)) throw new HubError(400, `${name} 必须是数组`)
  return value
}

/**
 * Accept an optional array of strings.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @returns {string[]|undefined} The array, or undefined when absent.
 * @throws {HubError} 400 when present with the wrong shape.
 */
function requireStringArray(value, name) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new HubError(400, `${name} 必须是字符串数组`)
  }
  return value
}

/**
 * Accept a value from a fixed set.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @param {string[]} allowed - Permitted values.
 * @returns {string|undefined} The value, or undefined when absent.
 * @throws {HubError} 400 when present but not permitted.
 */
function requireEnum(value, name, allowed) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HubError(400, `${name} 只能是 ${allowed.join(' 或 ')}`)
  }
  return value
}

/**
 * Parse a numeric field without silently coercing it.
 * @param {unknown} value - Raw value.
 * @param {string} name - Field name for the message.
 * @returns {number|undefined} The value, or undefined when absent.
 * @throws {HubError} 400 when present but not a positive integer.
 */
function optionalCount(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HubError(400, `${name} 必须是正整数`)
  }
  return parsed
}

/**
 * Compare `Origin` with `Host`.
 * @param {Record<string, any>} req - Incoming request.
 * @returns {string|undefined} A refusal reason, or undefined when acceptable.
 */
function originRefusal(req) {
  const origin = req.headers?.origin
  if (origin === undefined || origin === null || origin === '') return undefined
  // A same-origin fetch may omit Origin entirely; when it is present it must
  // match the Host the request arrived on.
  const host = req.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string') return 'malformed Origin or Host'
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return 'malformed Origin'
  }
  return parsed.host === host ? undefined : `cross-origin caller (${parsed.host} != ${host})`
}

/**
 * Write one JSON envelope.
 * @param {Record<string, any>} res - Response.
 * @param {number} status - HTTP status.
 * @param {Record<string, any>} payload - Envelope body.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON body with a size cap.
 * @param {Record<string, any>} req - Incoming request.
 * @returns {Promise<Record<string, any>>} Parsed object.
 * @throws {HubError} 400 on malformed input, 413 when oversized.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HubError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HubError(400, '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HubError(400, '请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * Attach the live stream to an open response.
 *
 * Returns without awaiting the connection: the handler's promise fulfilling is
 * not what keeps the response open — not calling `res.end()` is. Holding the
 * handler open instead would make the plugin's lifetime depend on a browser tab.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @param {Record<string, any>} req - Incoming request.
 * @param {Record<string, any>} res - Response.
 * @param {string} sessionId - Board to follow.
 * @returns {void}
 */
export function openStream(hub, req, res, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Reverse proxies that buffer break SSE; this is the portable opt-out.
    'x-accel-buffering': 'no',
  })
  // Ask the browser to come back in 2s after a drop, so a restart of the host
  // reconnects the panel without a page reload.
  res.write('retry: 2000\n\n')

  let closed = false
  const send = (event, data) => {
    if (closed || res.writableEnded === true || res.destroyed === true) return
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      cleanup()
    }
  }
  const unsubscribe = hub.subscribe(sessionId, send)
  const heartbeat = setInterval(() => {
    send('heartbeat', { now: Date.now() })
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  function cleanup() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
  }

  req.on?.('close', cleanup)
  req.on?.('error', cleanup)
  res.on?.('close', cleanup)
  res.on?.('error', cleanup)

  // The snapshot is sent after subscribing so no frame can slip between the
  // two: a change arriving during the write is already queued.
  send('snapshot', hub.state(sessionId))
}

/**
 * Register the route.
 * @param {Record<string, any>} ctx - Plugin context carrying the optional `webServer` service.
 * @param {import('./hub.js').Hub} hub - The hub.
 * @returns {(() => void)|undefined} Disposer, or undefined when no web server is composed.
 */
export function registerHubRoutes(ctx, hub) {
  const webServer = ctx.get?.('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return undefined
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS' || req.method === 'HEAD') {
        sendJson(res, 405, { ok: false, error: `${req.method} 不受支持` })
        return
      }
      const refusal = originRefusal(req)
      if (refusal !== undefined) {
        sendJson(res, 403, { ok: false, error: refusal })
        return
      }
      let url
      try {
        url = new URL(req.url ?? '/', 'http://localhost')
      } catch {
        sendJson(res, 400, { ok: false, error: '无法解析请求 URL' })
        return
      }
      const params = url.searchParams
      const method = (req.method ?? 'GET').toUpperCase()
      let body = {}
      if (method === 'POST') {
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, error instanceof HubError ? error.status : 400, { ok: false, error: messageOf(error) })
          return
        }
      }
      const op = params.get('op') ?? (typeof body.op === 'string' ? body.op : '')
      if (op === '') {
        sendJson(res, 400, { ok: false, error: '缺少 op 参数' })
        return
      }
      if (op === STREAM_OP) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'stream 只接受 GET' })
          return
        }
        openStream(hub, req, res, params.get('sessionId') ?? '')
        return
      }
      const operation = OPERATIONS[op]
      if (operation === undefined) {
        sendJson(res, 404, { ok: false, error: `未知操作 ${op}` })
        return
      }
      if (operation.write && method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `${op} 只接受 POST` })
        return
      }
      if (!operation.write && method !== 'GET') {
        sendJson(res, 405, { ok: false, error: `${op} 只接受 GET` })
        return
      }
      if (operation.write && req.headers?.[MARKER_HEADER] === undefined) {
        sendJson(res, 403, { ok: false, error: `写操作需要 ${MARKER_HEADER} 请求头` })
        return
      }

      // Cancellation is tied to the request: a browser that navigates away must
      // not leave a coordinator call or an inbox delivery running.
      const controller = new AbortController()
      req.on?.('close', () => { controller.abort(new Error('客户端断开连接')) })

      try {
        // Reads take their input from the query string, writes from the JSON
        // body; merging both would let a query parameter shadow a body field.
        // Parsing happens inside the try so a bad field answers 400 instead of
        // rejecting the handler and escaping the envelope.
        const input = method === 'GET'
          ? {
              sessionId: params.get('sessionId') ?? undefined,
              since: params.get('since') ?? undefined,
              limit: optionalCount(params.get('limit'), 'limit'),
            }
          : { ...body }
        const result = await operation.run(hub, input, controller.signal)
        sendJson(res, 200, { ok: true, result })
      } catch (error) {
        const status = error instanceof HubError ? error.status : 500
        if (status === 500) ctx.logger?.warn?.(`agent-hub: ${op} 失败：${messageOf(error)}`)
        sendJson(res, status, { ok: false, error: messageOf(error) })
      }
    },
  })
}
