/**
 * Prompts the hub sends to models.
 *
 * Two audiences, deliberately kept in one module so their shared wording — who
 * is on the team, what each one owns — cannot drift apart:
 *
 * - the **coordinator** is asked to split one objective into rows;
 * - each **child agent** is told which row is its own and how to report back.
 *
 * @module dsh-agent-hub/src/prompt
 */

/** Standing instructions for the coordinator split call. */
export const COORDINATOR_SYSTEM_PROMPT = [
  'You are the coordinator of a small team of coding agents that will run in parallel on one shared workspace.',
  'Split the objective into independent roles that can work at the same time without editing the same files.',
  '',
  'Output ONLY one JSON object, no prose, no code fence:',
  '{"agents":[{"name":"short name","role":"one line","task":"what this agent must produce","files":["path or glob it owns"],"write":true,"shell":false,"message":true,"model":"provider/model"}]}',
  '',
  'Rules:',
  '- Produce exactly the requested number of agents.',
  '- `task` is self-contained: it names the deliverable and how to verify it. The agent cannot see the other rows except through the brief you give it.',
  '- `files` lists the paths or globs this agent owns. Two agents must never own the same path; if the objective cannot be split that way, make one agent the owner and give the others read-only review roles.',
  '- `write` is false for research, review, and analysis roles. `shell` is false unless the role genuinely must run commands to verify its own work.',
  '- `message` is true when the role benefits from handing findings to a peer.',
  '- `model` assigns one route to this agent, copied EXACTLY from the route id before the first `｜` in the supplied list. Assign per role where it buys something, weighing cost, remaining quota and capability:',
  '  - **Match capability, not prestige.** Bulk mechanical work (formatting, checklist sweeps, simple retrieval) goes to a cheap/fast route; judgement-heavy work (architecture decisions, tricky debugging, final review) earns a strong route. Paying flagship prices for mechanical rows wastes quota that the judgement roles need.',
  '  - **Respect quota posture.** A route marked 额度紧张 must not be given to more than one or two roles per team, and never to bulk roles; spread bulk work across routes marked 额度充裕／一般.',
  '  - **Respect boundaries.** A route whose 边界 says it cannot do something (vision, deep reasoning) must not receive that role.',
  '  - **Use strengths.** Prefer a route whose 擅长 names the role\'s actual work.',
  '  - A DIFFERENT route for an adversarial reviewer is still the most valuable variety: a second model disagrees far more usefully than the same model re-reading itself. Using one route for everything remains correct when the roles are alike; do not manufacture variety.',
  '- Write `name`, `role`, and `task` in the language of the objective.',
  '- Do not invent facts about the repository; describe work, not its results.',
].join('\n')

/**
 * Build the coordinator's user message.
 *
 * The available routes are listed here rather than left to the model's knowledge,
 * because a route it invents is dropped by validation and every agent then falls
 * back to one model — the failure is silent and produces a team that cannot
 * disagree with itself. Each line carries the route id followed by cost, quota
 * posture, strengths and boundaries, so the choice can weigh price and
 * capability instead of prestige.
 * @param {{ objective: string, count: number, files?: string[], routes?: string[] }} input - Split input; `routes` entries may be pre-annotated.
 * @returns {string} User message text.
 */
export function buildCoordinatorRequest({ objective, count, files = [], routes = [] }) {
  return [
    `Objective: ${objective}`,
    `Number of agents required: ${count}`,
    ...(files.length === 0 ? [] : ['', `Files or directories already visible in the workspace: ${files.slice(0, 60).join(', ')}`]),
    ...(routes.length === 0
      ? []
      : [
          '',
          'Model routes you may use for `model` (copy the route id before the first ｜ EXACTLY; use only these; each line states cost / 额度 quota / 擅长 strengths / 边界 boundaries — these are estimates, trust the operator\'s values when they differ):',
          ...routes.slice(0, 24).map(route => `- ${route}`),
        ]),
    '',
    'Return the JSON object now.',
  ].join('\n')
}

/**
 * Build the persona registered on one child.
 *
 * The persona is a template with strict `{{…}}` interpolation, so this text
 * must never contain a double brace of its own.
 * @param {Record<string, any>} card - The agent's card.
 * @returns {string} Persona text.
 */
export function buildAgentPersona(card) {
  const limits = [
    'You are one agent on a shared board called the Agent Hub, working beside other agents that are running at the same time.',
    'Stay inside the files you were assigned; another agent may be editing everything else.',
    card.powers.write
      ? 'You may change the files you own.'
      : 'You are a read-only role: analyse and report, never modify files.',
    card.powers.shell
      ? 'You may run commands to verify your own work.'
      : 'Do not run shell commands; work from reading files.',
  ]
  const collaboration = card.powers.message
    ? [
        'Report progress on the shared board with the `hub_post` tool: post a short line when you reach a milestone, when you need something a peer owns, or when you finish.',
        'Read what the others have reported with `hub_read` before you start, so you do not duplicate their work.',
        'To hand something to a specific peer, pass their name as the `to` argument of `hub_post`; that delivers your message into their inbox.',
      ]
    : ['You cannot post to the shared board; finish your task and return your result.']
  return [...limits, ...collaboration, 'Prefer concrete output over commentary.'].join('\n')
}

/**
 * Build the initial user message of one child agent.
 * @param {Record<string, any>} card - The agent's card.
 * @param {string} objective - The team objective.
 * @param {{ name: string, role: string, files: string[] }[]} roster - Everyone on the team.
 * @returns {string} Delegation prompt.
 */
export function buildAgentPrompt(card, objective, roster) {
  const others = roster.filter(row => row.name !== card.name)
  return [
    objective === '' ? 'Shared objective: (not stated)' : `Shared objective: ${objective}`,
    '',
    `Your role: ${card.name}${card.role === '' ? '' : ` — ${card.role}`}`,
    `Your task: ${card.task}`,
    ...(card.files.length === 0 ? [] : [`Files you own: ${card.files.join(', ')}`]),
    '',
    ...(others.length === 0
      ? ['You are working alone on this objective.']
      : [
          'The rest of the team, working in parallel right now:',
          ...others.map(row => `- ${row.name}${row.role === '' ? '' : ` (${row.role})`}${row.files.length === 0 ? '' : ` — owns ${row.files.join(', ')}`}`),
        ]),
    '',
    'Do the work now. When you finish, post one line on the shared board with `hub_post` that says what you produced and where it is.',
  ].join('\n')
}
