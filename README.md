# dsh-agent-hub

A DSH plugin that runs **several agents on different models at the same time** on
one objective, and shows them exchanging progress on a single board.

## What it is for

DSH can already delegate to subagents, but you only ever see one of them. This
plugin merges *dispatch* and *watching* into one surface:

- **One objective → one split.** A coordinator model breaks the objective into
  independent roles, each owning a non-overlapping file scope. The result is an
  **editable table**: rename a role, rewrite its task, change its model, change
  its powers, then launch.
- **A different model per agent.** `deepseek-official/deepseek-flash`,
  `zai-coding-cn/glm-4.7`, … picked per row. This is the key difference from
  Agent Teams, whose members carry a provider but **no per-teammate model**.
- **Every agent visible at once.** Each lane shows status, model, elapsed time,
  token usage, the current step, and the **token-by-token text being written**.
- **Progress genuinely exchanged.** Agents post milestones to a shared board with
  `hub_post`, and can hand a line straight into a peer's inbox to wake it; you can
  interject into any agent, broadcast to all, or interrupt one.
- **Powers set per agent.** Read-only / may write files / may run commands,
  ticked in the UI. A read-only role is enforced with a tool whitelist — it truly
  cannot write, not merely asked not to.

It drives **real DSH subagent sessions** (with tools, workspace access and
multi-turn continuation), not "several models each say a paragraph".

## Install

```powershell
# from the dsh source checkout root
pnpm dsh plugin --profile web add <absolute path to this directory>
```

The **Host half requires a restart** of `dsh web` (it is an in-process ESM
module; replacing an installed package does not hot-reload it). The browser half
hot-reloads on its own. `restart-web.ps1` in this directory stops the current
listener and starts a fresh server.

## Using it

1. Open a conversation — a board is bound to a conversation.
2. Sidebar → **协作台 (Agent Hub)**, or the conversation tab of the same name.
3. Write the objective, press **智能拆分 (Split)**. Review the rows, change models
   and powers.
4. Press **并行启动 (Launch)**. N agents start at once; the lanes stream live.
5. To intervene: **steer** one agent (queue it, or cut into the running turn),
   **wake** an idle one, **interrupt** the current turn, or **broadcast** to all.

### One precondition

Dispatching requires the **parent conversation to have a live agent**. A cold
conversation returns a 409 with an actionable message. That is deliberate: the
plugin does not `resume` a session on your behalf, because a resumed handle is
owned by the caller — unloading the plugin would then tear down the conversation
you were using.

## The two tools the agents use

| Tool | Purpose |
|---|---|
| `hub_post` | Publish one line of progress to the shared board. With `to: '<name>'` it is also delivered into that teammate's inbox and wakes it. |
| `hub_read` | Read the roster plus everyone's latest progress — call it before starting so you do not duplicate a peer. |

## Status semantics

| Status | Meaning |
|---|---|
| `draft` | Not launched; still editable |
| `running` | Executing a turn |
| `idle` | Launched, currently between turns — **wakeable**, not finished |
| `done` | The run settled normally (still wakeable for another turn) |
| `error` / `stopped` | Failed / interrupted |

A terminal status comes from `subagent/end` alone. Session events report process
and never set a terminal state — otherwise one `turn/end` would show a waiting
agent as finished.

## The composer indicator

The strip above the composer shows one **segment per launched agent**, filled only
when that agent settles. It is intentionally *not* a percentage bar: how much work
is left in an open-ended run is unknowable, so any fill fraction would be
fabricated. Segments carry the honest counts (settled out of launched) and answer
"who is still going". There is no track when no agent exists, no sweeping
animation, no bounce, and `prefers-reduced-motion` freezes the pulse.

## Configuration

Optional, in `cordis.patch.yml` or the profile's patch layer:

| Option | Default | Meaning |
|---|---|---|
| `provider` | `''` | Subagent provider; empty = the first the runtime reports (`spawn`) |
| `maxAgents` | `8` | Launch ceiling |
| `defaultWrite` / `defaultShell` | `true` / `false` | Powers a new row starts with |
| `outputLimit` | `4000` | Retained output tail per agent, in characters |
| `feedLimit` | `200` | Feed items retained per board |
| `coordinatorTimeoutMs` / `coordinatorMaxTokens` | `120000` / `4000` | Split call |

An invalid value fails at **load** time rather than degrading at first use.

## Where the data lives

**Nowhere durable.** A board is a projection inside the host process, built from
`subagent/start|end`, `session/event`, `agent/assistant-stream` and
`agent/status`; it is empty after a restart. The agents themselves are durable
sessions and remain in the ordinary session list. The board describes *what is
happening*, so it is not a second source of truth — conclusions worth keeping
belong in your docs or a memory vault.

## Known boundaries

- The parent conversation must be live to dispatch or deliver (see above).
- The board is not persisted; a host restart clears it.
- Live transport is the plugin's own same-origin SSE route, with a **polling
  fallback**: after three consecutive failures the panel reads full state every
  2s and shows the connection as "Polling" until the stream recovers.
- Token-level text depends on `agent/assistant-stream`; without streaming the
  panel updates per step.
- Tool names are **probed against the live registry** before being used in a
  `toolFilter` — `tools.restrict()` throws on an unregistered name, so a guessed
  name would break every launch.

## Development

```powershell
node --no-warnings tests/smoke.mjs        # host half: route edges, orchestration, projection, stream
node --no-warnings tests/integration.mjs  # cross-half contract: host state → browser, browser payload → host
```

The host suite drives the **real** `apply`, route handler and event handlers
through a mock context, so it asserts the code that ships.

The integration suite is the valuable one: the two halves share only
`CONTRACT.md` and the wire, so either half can be green while the seam is broken.
It feeds the Host's actual snapshot into the browser half's pure functions, then
posts the payload the browser half builds back through the Host's validation.

`tests/check-primitives.mjs` needs the DSH checkout and is not part of
`npm test`: it diffs every primitive and icon name `client.js` destructures
against the shell's real artifact (`packages/client/ui-primitives/lib/index.js`).
A wrong name white-screens the panel in the browser, where no Node-side test can
see it.

## License

Not yet declared.
