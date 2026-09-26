# 协作台接口契约（宿主半 ↔ 浏览器半）

本文件是两半之间**唯一**的接口约定。任何一侧改动都必须先改这里。

- 同源路由：`/agent-hub`
- 每个请求都要带标记头 `x-dsh-agent-hub: 1`（跨源表单发不出该头，用来挡 CSRF；它不是身份认证）
- 读操作 `GET`，写操作 `POST`（方法由操作决定，不是由"是否变更"决定）
- 响应统一信封：`{ "ok": true, "result": ... }` 或 `{ "ok": false, "error": "..." }`
- 跨源（`Origin` 与 `Host` 不一致）一律 `403`

## 概念

- **board（协作台）**：一个会话对应一块协作台，主键是 `sessionId`（父会话）。
- **agent（智能体）**：一个真实的 DSH 子智能体会话，有独立的 provider/model 与工具范围。
- **feed（进度板）**：所有进度与消息按时间排成的一条流。

## 数据结构

### AgentCard

```jsonc
{
  "clientId": "a1",              // 本地标识；未启动时用它，启动后仍有（稳定）
  "id": "session-xxx" | null,    // 子会话 id；未启动为 null
  "name": "架构",
  "role": "负责接口设计与拆分",
  "task": "给出模块边界与接口签名",
  "model": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "max" },
  "powers": { "read": true, "write": true, "shell": false, "message": true },
  "files": ["src/**"],           // 负责的文件范围，仅作声明与展示
  "status": "draft|queued|running|idle|done|error|stopped",
  "activity": "正在编辑 src/http.js",   // 最近一次动作的一句话
  "output": "…已提交的输出尾部…",         // 纯文本尾部，最多约 4000 字符
  "live": "…正在流式生成的文本…",         // 逐 token 增量；提交后清空。与 output 分开，便于区分"正在打字"
  "usage": { "input": 0, "output": 0 },
  "toolCalls": 0,
  "createdAt": 0, "startedAt": null, "endedAt": null, "lastActivityAt": 0,
  "error": null,
  "unread": 0
}
```

`status` 含义：`draft` 未启动（可编辑）；`queued` 已提交启动；`running` 正在跑；`idle` 已启动但当前空闲（可被唤醒）；`done`/`error`/`stopped` 终态。

`output` 与 `live` 的分工很重要：`output` 只装**已提交**的步骤输出，`live` 装当前这一步正在生成的增量；`assistant/message` 提交时 `live` 清空、其文本进入 `output`。界面应把 `live` 用不同样式接在 `output` 之后，而不是把它当历史。

### FeedItem

```jsonc
{
  "id": "f12",
  "time": 1730000000000,
  "kind": "plan|progress|message|handoff|human|system",
  "from": "human|system|<agentId>",
  "fromName": "架构",
  "to": "*|<agentId>|null",
  "toName": null,
  "agentId": "<agentId>|null",
  "text": "接口定稿：/agent-hub?op=state 返回 …"
}
```

### 分工草案（draft）

```jsonc
{
  "objective": "把构建脚本迁移到 pnpm",
  "agents": [ { "clientId": "a1", "name": "…", "role": "…", "task": "…",
                "model": {"provider": "…", "model": "…", "reasoningEffort": "max"},
                "powers": {"read": true, "write": true, "shell": false, "message": true},
                "files": [] } ]
}
```

## 读操作

### `GET /agent-hub?op=state&sessionId=<父会话id>`

返回整块协作台的快照：

```jsonc
{
  "ok": true,
  "result": {
    "sessionId": "session-xxx",
    "objective": "…",
    "phase": "idle|planned|running|done",   // idle 无草案；planned 有草案未跑；running 有在跑；done 全部终态
    "agents": [AgentCard],
    "feed": [FeedItem],          // 最近 200 条，最旧在前
    "team": {                    // DSH 原生 Agent Teams 的状态：**读**出来而不是镜像
      "available": true,         // 该部署是否组合了 agentTeams 服务
      "readable": true,          // 是否真的读到了（false 时看 error）
      "members": [ { "id": "session-x", "name": "reviewer", "role": "lead|teammate",
                     "status": "running|inactive|provisioning|failed",
                     "description": "…", "provider": "spawn", "model": "glm-4.7" } ],
      "tasks":   [ { "id": "task-7", "revision": 3, "subject": "…", "description": "…",
                     "status": "pending|in_progress|completed|deleted", "ready": true,
                     "ownerName": "reviewer", "writeScopes": ["docs/**"], "blockedBy": ["task-3"] } ],
      "error": null,             // 读取失败的原因
      "warning": null            // 桥接写入（开台时把分工发布成原生任务）的非致命失败
    },
    "providers": ["spawn", "fork"],
    "hasLLM": true,              // 是否能调用协调者模型（draft 需要）
    "now": 1730000000000
  }
}
```

`sessionId` 缺省或未知时返回一块空台（`phase: "idle"`，空数组），**不报错**。

### `GET /agent-hub?op=models`

```jsonc
{ "ok": true, "result": { "providers": [
  { "provider": "deepseek-official", "name": "DeepSeek", "models": [ { "id": "deepseek-flash", "name": "DeepSeek Flash" } ] }
] } }
```

取不到某个 provider 的模型时该 provider 的 `models` 为空数组，不影响其它 provider。

### `GET /agent-hub?op=feed&sessionId=<id>&since=<feedItemId>&limit=<1..500>`

```jsonc
{ "ok": true, "result": { "items": [FeedItem], "lastId": "f12" } }
```

### `GET /agent-hub?op=stream&sessionId=<id>`

`text/event-stream`。帧格式为标准 SSE：

```
event: snapshot
data: {"sessionId":"…","agents":[…],"feed":[…],"phase":"running"}
```

事件名：

| event | data | 何时 |
|---|---|---|
| `snapshot` | 与 `op=state` 的 result 同形 | 连接建立时立刻发一次 |
| `agent` | 完整 AgentCard（覆盖式，不是补丁） | 某智能体状态/输出/用量变化（服务端按 ≥150ms 合并；逐 token 增量也走这一帧） |
| `feed` | 单个 FeedItem | 新增一条进度或消息 |
| `board` | `{ sessionId, objective, phase, teamWarning? }` | 草案/阶段变化；`teamWarning` 只携带桥接写失败，客户端应**合并**进上一次团队快照而不是覆盖 |
| `heartbeat` | `{ now }` | 每 15 秒 |

- 客户端断线自己重连（1s 起、×1.7、上限 15s）；服务端给了 `retry: 2000`。
- 服务端在客户端断开时必须清理订阅（`req`/`res` 的 `close` 事件）。
- **SSE 不可用时的兜底**：连续失败 3 次后，客户端降级为**每 2 秒 `GET ?op=state`**（而不是按 `feed&since` 增量拉取——200 条的窗口下二者等价，而整份状态少一条代码路径），并把连接状态显示为「轮询」。降级期间仍继续尝试重开 EventSource，一旦 `onopen` 成功就停止轮询并切回实时。
- 注意 `retry: 2000` 会作为**不含 `event:` 字段的块**出现在流里，客户端解析时要跳过它（`client.js` 的帧解析已如此处理）。

## 写操作（一律 POST，body 为 JSON，含 `op`）

| op | body | result |
|---|---|---|
| `draft` | `{ sessionId, objective, count?, coordinator?: {provider, model} }` | `{ draft, usage }` |
| `launch` | `{ sessionId, objective, agents: [草案里的 agent] }` | `{ agents: [AgentCard] }` |
| `steer` | `{ sessionId, agentId, text, delivery?: "queue"\|"steer" }` | `{ accepted: true, messageId }` |
| `broadcast` | `{ sessionId, text, to?: [agentId] }` | `{ accepted: true, delivered: n }` |
| `interrupt` | `{ sessionId, agentId }` | `{ accepted: true }` |
| `agent.wake` | `{ sessionId, agentId, text? }` | `{ accepted: true }` |
| `stopAll` | `{ sessionId }` | `{ accepted: true, stopped: n }` |
| `clear` | `{ sessionId }` | `{ accepted: true }` |

规则：

- **一块台属于一个会话。** 属于该会话的任何子智能体（含"子智能体的子智能体"）都解析到**同一块台**，因此看得到同一批同伴的摘要；`state` 返回的 `sessionId` 是解析后的会话 id，而不是调用方传进来的那个。
- **会话之间互不可见。** 对话 B 的台不会出现在对话 A 的任何读取里，反之亦然。
- **子智能体不能开台或清台**（`draft` / `launch` / `clear` 返回 409）：它已经是某个会话的子智能体，只能与那块台上的同伴协作。被替换掉（重新派发或清台）的直接子智能体失去访问，报"不在任何协作台上"。
- **所有写操作的必填字段都要显式校验**；缺字段或类型不对返回 `400` 并带可读 `error`，不要静默回退默认值。
- `launch` 的 `agents` 至少 1 个、至多 8 个。
- `draft` 需要宿主有 `llm` 服务；没有则返回 `503` 与"无法调用协调者模型"。
- 智能体没启动（`draft` 状态）时 `steer`/`interrupt` 返回 `409`。
- 未知 `op` 返回 `404`。

## 权限到工具范围的映射

`powers` 由宿主半翻译成子智能体的 `toolFilter`：

- `read` 恒为真（只读是底线，不提供关闭）。
- `write: false` → 拒绝文件写入类工具。
- `shell: false` → 拒绝命令执行类工具。
- `write && shell 均为 false` → 改用**白名单**（`allow`），只留只读与协作类工具。
- 工具名必须先在当前注册表里探测存在再放进过滤条件：`tools.restrict()` 对未知名字会**抛错**。
