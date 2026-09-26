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
  '- `model` assigns one route to this agent, copied EXACTLY from the list supplied in the request. Assign per role where it buys something: a stronger route for the part that needs judgement, a cheaper or faster one for mechanical work, and — most valuable — a DIFFERENT route for an adversarial reviewer, because a second model disagrees with the first far more usefully than the same model re-reading itself. Using one route for everything is the right answer when the roles are alike; do not manufacture variety.',
  '- Write `name`, `role`, and `task` in the language of the objective.',
  '- Do not invent facts about the repository; describe work, not its results.',
].join('\n')

/**
 * Build the coordinator's user message.
 *
 * The available routes are listed here rather than left to the model's knowledge,
 * because a route it invents is dropped by validation and every agent then falls
 * back to one model — the failure is silent and produces a team that cannot
 * disagree with itself.
 * @param {{ objective: string, count: number, files?: string[], routes?: string[] }} input - Split input.
 * @returns {string} User message text.
 */
export function buildCoordinatorRequest({ objective, count, files = [], routes = [] }) {
  return [
    `Objective: ${objective}`,
    `Number of agents required: ${count}`,
    ...(files.length === 0 ? [] : ['', `Files or directories already visible in the workspace: ${files.slice(0, 60).join(', ')}`]),
    ...(routes.length === 0
      ? []
      : ['', `Model routes you may use for \`model\` (copy one exactly; use only these): ${routes.slice(0, 24).join(', ')}`]),
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
