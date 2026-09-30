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
- **Two surfaces: in progress / finished.** The lane area lists only what is *happening
  now*; finished agents (done / error / stopped) move to the completed page and **keep
  their actions** — waking one to ask a follow-up is exactly what it is for.
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
# straight from GitHub
pnpm dsh plugin --profile web add github:HuaimaoCy/dsh-agent-hub

# or from the released tarball
pnpm dsh plugin --profile web add https://github.com/HuaimaoCy/dsh-agent-hub/releases/latest/download/plugin.tgz

# or from a local checkout
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

## Agents that actually reach for it

A board nobody opens is decoration, and a tool nobody calls is invisible. So the
plugin does two things beyond the UI:

**A standing policy in every agent's prompt** (`src/policy.js`). It is written as
a policy rather than a slogan, because both failure modes are real: an agent that
has never been told what the board is for keeps solving everything
single-threaded, while an agent told to "use it a lot" parallelises a two-line
edit and pays a coordinator call plus N agent contexts for it. So it states

- **triggers** — the objective splits into genuinely independent parts; breadth
  across modules/options/sources is what is wanted; a *different model's*
  judgement is worth having; the long part should run while the conversation
  continues; a read-only role should attack another's output;
- **anti-triggers** — steps depend on each other; one file, or roles that must
  write the same files; a task two or three steps will finish (dispatching costs
  more than it saves); context that cannot be handed over in one prompt, because
  a child cannot see your conversation;
- the mechanics, so knowing *when* is enough to know *how*;
- one live line about the board as it is right now, so an agent joins the team
  that exists instead of opening a second one on top of it.

**A `hub_launch` tool**, because the policy is unactionable without it: before
this, an agent could post to a board and read one, but only a human pressing a
button could create one. `hub_launch` takes an objective (the coordinator splits
it) or an objective plus an explicit roster (the coordinator call is skipped),
and returns the launched team. Roster rows default to **read-only** — a model
that did not ask to write does not get a writing agent by accident.

The policy text rides on every request of every session in the deployment, so it
can be switched off with `policy: false`; the board then exists purely as a UI
surface.

## Spreading work across providers

Three levels, from least to most explicit:

| You want | How |
|---|---|
| **A different model** to review the work | Name `provider` / `model` on that row; the policy tells the agent which routes exist |
| To **spread** the work without picking row by row | Pass `models: ["provider/model", …]`; rows that name no model are assigned from it in turn |
| The **coordinator** to assign per role | Pass nothing: the coordinator is given the catalogue and assigns (judgement-heavy roles get a stronger route, mechanical ones a cheaper one, and an **adversarial reviewer deliberately gets a different model**) |

Three pieces make that work:

1. **The policy section lists the available routes** (`可用模型路由（provider/model，共 N 条）：…`,
   read live from the catalogue, capped at 12). Without it an agent has to invent route
   names — and an invented route is dropped by validation, so the entire team silently
   lands on one model with nothing reporting a problem.
2. **The coordinator's request carries the catalogue**, with the instruction that `model`
   must be copied exactly, and that one route for every role is the right answer when the
   roles are alike: **do not manufacture variety**.
3. **`hub_launch` takes `models`**: it fills rows of an explicit roster that name no model,
   and it backstops the coordinator's rows when it named none. Malformed entries
   (`broken/`, `/nope`) are dropped rather than failing the launch.

> The gap this closed: the coordinator's prompt had **no model field at all** and nothing
> told it which providers existed, so an auto-split team **always ran on one model**.
> Per-row routes worked, but only if you wrote the roster yourself.

A per-row route that no provider serves **fails that row's launch with the reason** (the
other rows keep running) rather than being quietly replaced with another model.

## Relationship to the built-in Agent Teams

The two overlap — a roster, a shared board, messages between members — so this is
an **integration**, not two features standing side by side:

| | Who owns it |
|---|---|
| Durability: members, tasks, dependencies, write scopes | **Agent Teams** — written to the Lead's session log, survives a restart |
| Per-agent model, per-agent tool scope, live token view | **the hub** — the native `spawn_teammate` carries `provider` but no model |

Three things follow:

1. **One board.** The panel draws the hub's lanes and the native roster together:
   `op=state` reads `ctx.agentTeams` for its `team` field instead of mirroring it,
   so a change on the native side — including tasks created by the native tools —
   shows up here immediately.
2. **One plan.** A roster approved through `hub_launch` is published as **native
   tasks** (`createTask` → `claim`), and each agent's task is completed by
   compare-and-set when it settles. The Team panel, `team_task_list` and this
   board therefore read the same revisioned, dependency-aware task table — not a
   free-text "plan" beside a real one.
3. **Failures stay non-fatal.** A refused task write does not cancel a launch (the
   agents are already running); it leaves one visible warning on the team block
   instead of filling the feed with retry noise.

### One seam remains

The native `list_agents` / `send_message` **do not see hub-dispatched agents** —
they are not team members. The reason is specific: `SpawnTeammateRequest` carries
`provider` but no model, and the team service has **no API to adopt an existing
child**, so going through the native spawn would cost every agent its model, which
is the point of the feature.

Two ways to close it, neither implemented:

- **The upstream way**: add `agentOptions` to `SpawnTeammateRequest` and thread it
  into the internal `startContinuable`. The capability already exists — the `spawn`
  provider advertises `agentOptions/persona/toolFilter` and the continuable path
  does not check capabilities — the Team layer simply never passes it down.
- **Hand-written events**: `session.append('team/member', …)` does register a hub
  agent as a member, and hub children happen to satisfy the
  "Lead's direct continuable child" requirement for delivery. But the projection
  validates strictly, and **one invalid record puts that session's Agent Teams
  into a permanent `failure`** where no further event applies. That is not a cost a
  third-party plugin should impose on someone else's session, so it is not used.

## The lead is on the board too

It does a share of the work — the policy tells it to "get on with your own share" —
so it is the **first lane**: status, model, current step, output tail and token
usage, exactly like a dispatched agent.

It is **not** in the dispatchable roster, though. That array is the set you can
steer, wake and interrupt, and putting the lead in it would have three
consequences: a re-launch would replace it as a stale roster, **"stop all" would
interrupt the conversation you are talking in**, and the plan editor would offer it
as an editable draft row. So it lives in the Host's `state.lead`, travels on its own
`lead` event, and renders as a lane with **no action bar** — you do not interrupt
yourself.

Its events are attributed by the same rule: **the parent conversation's own** session
events (tool calls, replies, usage) fold into its card, while a deeper descendant — a
helper one of our agents started — is on the same board but its output is **not**
credited to the lead.

## Visibility: one board, and only one

**An agent sees the summaries of the agents on its own conversation's board, and
nothing else.** Another conversation's board is invisible to it. The boundary is
enforced in code, not by convention:

- **A board belongs to a conversation.** Any subagent of that conversation — down
  to a subagent's own subagent — resolves to the same board, so it reads the same
  peers: names, roles, status, latest progress.
- **Conversations do not see each other.** B's board never appears in A's reads.
- **A subagent cannot open or clear a board** (409). It is already a subagent of a
  conversation and works with the peers on that board; `hub_read` to look,
  `hub_post` to report.

> Why this had to be code: a child session's `session.id` is its own. Without
> resolution, a subagent calling launch would allocate a **second board keyed by
> its own id**, and from that moment its `hub_read` would return that empty board
> instead of the team it is working with — the roster would fragment **silently**,
> with no error anywhere. So "a board belongs to a conversation" is a resolution
> rule, not a sentence in a prompt.

An agent whose card was replaced loses access with it: after a re-launch or a
cleared board, a stale child reporting in gets "not on any board" rather than
writing into an unfamiliar empty one.

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

## Agents the conversation starts itself

A hub board is not limited to what the hub launched. When *any* agent starts a
child in this conversation — the native `subagent` tool, an Agent Teams teammate,
or anything else — that child is **adopted**: it gets a lane with its own name,
route, status, activity and output, and its progress streams onto the board like any
other row.

`subagent/start` carries the child's session id but **not** its parent, so the parent
is read from the child's own session header. Adoption also **creates the board when
none exists yet**: a conversation that starts help before anyone opens the hub would
otherwise have nowhere to show it.

Two boundaries, both deliberate:

- **Direct children only.** A grandchild — a helper one of our agents started — is a
  *participant* of the same board (it can `hub_read` and `hub_post`) but does not get
  a row. The parent must be the board's own session, not merely resolve to it;
  otherwise the board would turn into a call tree.
- **Adopted rows are never launched from.** They appear in the plan editor's source
  data but are filtered out of it, because launching from an adopted row would
  dispatch a second copy of an agent that is already running. The Host keeps them out
  of the spawn path for the same reason, and a test pins both halves.

## Where the panel lives

Three slots: the main panel, a `conversation.view` tab, and a sidebar entry.

There is deliberately **no composer dock**. The hub used to render a strip above the
input box with a "run it in parallel with the Agent Hub" hint and an "open the hub"
button; both are gone. The strip made a claim about every message the user typed —
whether or not this message was parallel work — and the panel was already one click
away. A tool does not need to advertise itself in the middle of the place you type.

## Configuration

Optional, in `cordis.patch.yml` or the profile's patch layer:

| Option | Default | Meaning |
|---|---|---|
| `provider` | `''` | Subagent provider; empty = the first the runtime reports (`spawn`) |
| `maxAgents` | `8` | Launch ceiling |
| `defaultWrite` / `defaultShell` | `true` / `false` | Powers a new row starts with |
| `policy` | `true` | Whether the "when to use the hub" section rides in every agent's system prompt |
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
