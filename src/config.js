/**
 * Configuration for the Agent Hub.
 *
 * The host validates this once at load time through the exported `Config`
 * (Standard Schema shape) instead of reading `ctx.config`, because an
 * out-of-tree plugin receives its config as an argument to `apply` and a bad
 * value must fail loudly at load rather than degrade at first use.
 *
 * @module dsh-agent-hub/src/config
 */

/** Every option, with the value an omitted option takes. */
export const DEFAULT_CONFIG = {
  /** Subagent provider that composes the children; empty means "first the runtime reports". */
  provider: '',
  /** Hard ceiling for one launch, and the server-side backing for the UI's own limit. */
  maxAgents: 8,
  /** Whether a draft row created without an explicit power starts able to write files. */
  defaultWrite: true,
  /** Whether a draft row created without an explicit power starts able to run commands. */
  defaultShell: false,
  /**
   * Whether the standing "when to use the hub" policy rides in every agent's
   * system prompt.
   *
   * On by default, because the feature is only useful if agents reach for it. Off
   * is a supported choice: this text is sent on every request of every session in
   * the deployment, so an operator who wants the board to exist purely as a UI
   * surface should be able to stop paying for the prompt space.
   */
  policy: true,
  /** Length of one agent's retained output tail, in characters. */
  outputLimit: 4000,
  /** Feed items retained per board. */
  feedLimit: 200,
  /** Deadline for one coordinator split call, in milliseconds. */
  coordinatorTimeoutMs: 120000,
  /** Output cap for the coordinator split call. */
  coordinatorMaxTokens: 4000,
  /**
   * Operator corrections to the built-in route metadata, keyed by exact
   * `provider/model` (or provider alone). Each entry may set `in` / `out`
   * (USD per million tokens), `metered: false` for subscription routes,
   * `tier` (`free|cheap|mid|high`), `quota` (`ample|normal|thin`),
   * `strengths`, `boundaries`. Values are merged over the built-in estimates,
   * so an operator with real prices or live quota posture can correct the
   * coordinator's assignment input without touching code.
   */
  routeMeta: {},
}

/** Options this plugin accepts; anything else is rejected. */
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * Validate one raw config value.
 * @param {unknown} raw - Value the loader passed to `apply`.
 * @returns {{ value: typeof DEFAULT_CONFIG }|{ issues: { message: string, path?: string[] }[] }} Normalized value, or the problems found.
 */
export function normalizeConfig(raw) {
  const issues = []
  if (raw === undefined || raw === null) return { value: { ...DEFAULT_CONFIG } }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config must be an object', path: [] }] }
  }
  const value = { ...DEFAULT_CONFIG }
  for (const [key, entry] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      issues.push({ message: `unknown option "${key}"; known options: ${[...KNOWN_KEYS].join(', ')}`, path: [key] })
      continue
    }
    if (key === 'provider') {
      if (typeof entry !== 'string') {
        issues.push({ message: 'provider must be a string', path: [key] })
        continue
      }
      value.provider = entry.trim()
      continue
    }
    if (key === 'routeMeta') {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push({ message: 'routeMeta must be an object keyed by provider/model', path: [key] })
        continue
      }
      value.routeMeta = entry
      continue
    }
    if (key === 'defaultWrite' || key === 'defaultShell' || key === 'policy') {
      if (typeof entry !== 'boolean') {
        issues.push({ message: `${key} must be a boolean`, path: [key] })
        continue
      }
      value[key] = entry
      continue
    }
    // The remaining options are numbers with a lower bound that keeps the
    // feature meaningful: a zero-length tail or a one-item feed is a bug.
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1) {
      issues.push({ message: `${key} must be a positive integer`, path: [key] })
      continue
    }
    value[key] = entry
  }
  if (value.maxAgents > 32) {
    issues.push({ message: 'maxAgents must be at most 32', path: ['maxAgents'] })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** Standard Schema entry the host validates through. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-agent-hub',
    validate: normalizeConfig,
  },
}
