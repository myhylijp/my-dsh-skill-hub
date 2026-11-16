/**
 * Skill hub — Host half.
 *
 * One process-wide *skill pool* on disk (`<dshHome>/skills`, the same root the
 * shipped filesystem provider calls the `user-dsh` root) plus one
 * *authorization table* that says which pool skills each agent preset may use.
 *
 * Enforcement rides the layered skill registry: every live Agent gets its own
 * provider registered through `agent.ctx.skills`, so it lands in that Agent's
 * scope layer. The provider lists a pool skill with its real invocation policy
 * when the Agent's preset is authorized, and with a disabled policy when it is
 * not — a disabled entry wins over the same name in a global or preset layer,
 * so an unauthorized skill disappears from the model catalog and from the `/`
 * menu instead of merely failing when loaded.
 *
 * The Client half talks to this module over the exact owner-only HTTP route
 * `/api/skill-hub` registered on the Connection Fetch registry, which admits
 * only the authenticated owner Peer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** Row id / Client module id used by the patch and the client bundle. */
export const name = 'skill-hub'

/** Host services this row needs; `connection` is probed instead (headless profiles have no carrier). */
export const inject = ['agents', 'skills', 'agentPresets', 'webServer']

/** Exact owner-only HTTP route carrying the page's JSON requests. */
const HTTP_PATH = '/api/skill-hub'
/**
 * Host build marker, reported in the page snapshot. A running Harness keeps its
 * loaded modules, so this states which Host half the page is talking to.
 */
const HOST_REVISION = '2026-11-14.5'
/** Provider name registered in every Agent's scope layer. */
const PROVIDER_NAME = 'skill-hub'
/** Source label of a pool skill in the registry. */
const SOURCE = 'custom'
/** `skills/` pool entries are one of these. */
const SKILL_FILE = 'SKILL.md'

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2000
const MAX_PREVIEW_CHARS = 200_000
const POOL_CACHE_MS = 1500
const BUILTIN_CACHE_MS = 2000

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/**
 * Spelling accepted in a SKILL.md `name`. The shipped skill registry only
 * accepts kebab-case (its `skill` tool contract), so underscore, dot, and
 * uppercase spellings are normalized to that grammar at parse time instead of
 * being rejected.
 */
const DECLARED_NAME = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const DECLARED_NAME_MAX = 96
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/i
const SKILL_NAME_MAX = 64

/** Authorization used by every preset without an explicit entry. */
const DEFAULT_POLICY = 'all'

/** A failure the Client can present verbatim. */
class HubError extends Error {
  /**
   * @param {string} code - stable machine code for the Client.
   * @param {string} message - user-facing, already localized at the page.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HubError'
    this.code = code
  }
}

/**
 * Resolve the row configuration, tolerating a missing or partial config.
 * @param {Record<string, unknown>} config - row config from the patch.
 * @returns {{dshHome: string, poolDir: string, stateDir: string, defaultPolicy: 'all'|'none'}}
 */
function resolveSettings(config) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const dshHome = typeof config?.dshHome === 'string' && config.dshHome.length > 0 ? resolve(config.dshHome) : home
  const poolDir = typeof config?.poolDir === 'string' && config.poolDir.length > 0
    ? resolve(config.poolDir)
    : join(dshHome, 'skills')
  const stateDir = typeof config?.stateDir === 'string' && config.stateDir.length > 0
    ? resolve(config.stateDir)
    : join(dshHome, 'skill-hub')
  const policy = config?.defaultPolicy === 'none' ? 'none' : DEFAULT_POLICY
  return { dshHome, poolDir, stateDir, defaultPolicy: policy }
}

/**
 * Install the Skill hub.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context of this row.
 * @param {Record<string, unknown>} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const hub = new SkillHub(ctx, resolveSettings(config))
  ctx.effect(() => () => hub.dispose(), 'skill-hub: lifecycle')
  hub.start()
}

/** Owner of the pool, the authorization table, and the per-Agent providers. */
class SkillHub {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
   * @param {ReturnType<typeof resolveSettings>} settings - resolved paths and policy.
   */
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    /** @type {Map<string, {agent: object, invalidate: () => void, dispose: () => void}>} */
    this.providers = new Map()
    /** @type {Map<string, number>} */
    this.retries = new Map()
    /** @type {{at: number, entries: object[]} | undefined} */
    this.poolCache = undefined
    /** @type {{stamp: string, value: {version: number, presets: Record<string, {skills: string[]}>}} | undefined} */
    this.authCache = undefined
    /** @type {Map<string, {at: number, value: object[]}>} */
    this.builtinCache = new Map()
    this.disposed = false
  }

  /** Register the Host hooks: Agent lifecycle, preset switches, and the RPC channel. */
  start() {
    const ctx = this.ctx
    ctx.on('agent/created', ({ agent }) => { this.syncAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      this.providers.delete(agent.id)
      this.retries.delete(agent.id)
    })
    ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined) this.syncAgent(agent, true)
    })
    for (const agent of ctx.agents.list()) this.syncAgent(agent)
    // 必须等 connection 服务就绪再注册路由：启动时它可能晚于本行挂载，
    // 之前用 ctx.get 直接探测过一次，探测不到就永久放弃注册 —— 表现为技能页
    // 一直 404，只有到插件管理里停用/启用一次（重新 apply）才恢复。
    ctx.inject(['connection'], (child) => {
      const connection = readService(child, 'connection')
      if (connection?.fetch?.register === undefined) {
        ctx.logger?.warn?.('skill-hub: no Connection route carrier; the Skills page cannot read or change the pool')
        return
      }
      child.effect(
        () => connection.fetch.register({
          path: HTTP_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: request => this.handleHttp(request),
        }),
        'skill-hub: http route',
      )
    })
  }

  /**
   * Release this row: unregister every Agent-scoped provider it installed
   * (those effects belong to the Agent scopes, so they outlive this plugin
   * unless removed here) and drop the caches.
   */
  dispose() {
    this.disposed = true
    for (const record of this.providers.values()) record.dispose()
    this.providers.clear()
    this.retries.clear()
    this.poolCache = undefined
    this.authCache = undefined
    this.builtinCache.clear()
  }

  // ── Provider enforcement ──────────────────────────────────────────────────

  /**
   * Register (or replace) the Agent-scoped provider that projects the pool
   * through this Agent's preset authorization.
   * @param {object} agent - live Agent whose scope layer receives the provider.
   * @param {boolean} [force] - replace an existing registration (preset switch).
   */
  syncAgent(agent, force = false) {
    if (this.disposed) return
    const existing = this.providers.get(agent.id)
    if (existing !== undefined) {
      if (!force) return
      try { existing.dispose() } catch { /* already torn down with its scope */ }
      this.providers.delete(agent.id)
    }
    const registry = readService(agent.ctx, 'skills') ?? readService(this.ctx, 'skills')
    if (registry?.registerProvider === undefined) {
      // A registry that is still settling must not fail Agent creation: retry a
      // few times instead of leaving the Agent permanently unprojected.
      const attempts = (this.retries.get(agent.id) ?? 0) + 1
      this.retries.set(agent.id, attempts)
      if (attempts <= 5) {
        const timer = setTimeout(() => { this.syncAgent(agent) }, 300 * attempts)
        timer.unref?.()
      }
      return
    }
    this.retries.delete(agent.id)
    /** @type {{invalidate: () => void} | undefined} */
    let control
    let dispose
    try {
      dispose = registry.registerProvider((registrationControl) => {
        control = registrationControl
        return this.createProvider(agent)
      })
    } catch (error) {
      this.ctx.logger?.warn?.(`skill-hub: agent ${String(agent.id)} provider skipped: ${describe(error)}`)
      return
    }
    this.providers.set(agent.id, {
      agent,
      invalidate: () => { try { control?.invalidate() } catch { /* registration retired */ } },
      dispose: () => { try { dispose?.() } catch { /* scope already disposed */ } },
    })
  }

  /**
   * Build the borrowed provider for one Agent. `list` reads the pool catalog
   * plus the built-in skills of the Agent's preset, applies the preset
   * authorization, and emits `disabled` shadows for every denied name; `get`
   * loads the live body only for an authorized pool entry.
   * @param {object} agent - Agent whose preset selects the authorization.
   * @returns {object} a `SkillProvider`.
   */
  createProvider(agent) {
    return {
      name: PROVIDER_NAME,
      list: () => this.providerCandidates(agent),
      get: async (candidate) => {
        const entry = candidate.locator
        if (entry?.authorized !== true) return undefined
        let text
        try {
          text = readFileSync(entry.path, 'utf8')
        } catch {
          return undefined
        }
        const parsed = parseSkillDocument(text)
        if (!parsed.ok || parsed.name !== candidate.name) return undefined
        return {
          name: parsed.name,
          description: parsed.description,
          ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
          invocation: parsed.invocation,
          source: SOURCE,
          provider: PROVIDER_NAME,
          path: entry.path,
          resourceBase: { kind: 'directory', path: entry.root },
          content: parsed.content,
        }
      },
    }
  }

  /**
   * Candidates visible to one Agent: authorized skills keep their policy,
   * unauthorized pool skills *and* the preset's built-in skills the role turned
   * off become `disabled` shadows that no surface will advertise.
   * @param {object} agent - Agent whose preset selects the authorization.
   * @returns {Promise<object[]>} registry candidates.
   */
  async providerCandidates(agent) {
    let entries
    try {
      entries = this.poolEntries()
    } catch (error) {
      this.ctx.logger?.warn?.(`skill-hub: pool scan failed: ${describe(error)}`)
      return []
    }
    const presetId = this.presetOf(agent)
    const { pool, builtinDisabled } = this.authorizationFor(presetId)
    const candidates = []
    const poolNames = new Set()
    for (const entry of entries) {
      if (entry.error !== undefined) continue
      poolNames.add(entry.name)
      const authorized = pool === 'all' || pool.has(entry.name)
      candidates.push({
        name: entry.name,
        description: entry.description,
        ...entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {},
        invocation: authorized ? entry.invocation : { modelInvocable: false, userInvocable: false },
        source: SOURCE,
        provider: PROVIDER_NAME,
        rank: 0,
        path: entry.path,
        resourceBase: { kind: 'directory', path: entry.root },
        locator: {
          name: entry.name,
          path: entry.path,
          root: entry.root,
          authorized,
          profile: entry.profile,
        },
      })
    }
    if (builtinDisabled.size === 0) return candidates
    // A role may drop a skill its own preset composes: shadow it in the Agent's
    // layer, which every preset and global provider sits below.
    const builtin = await this.builtinSkills(presetId)
    for (const name of builtinDisabled) {
      if (poolNames.has(name)) continue
      const skill = builtin.get(name)
      if (skill === undefined) continue
      candidates.push({
        name,
        description: skill.description,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        invocation: { modelInvocable: false, userInvocable: false },
        source: skill.source ?? SOURCE,
        provider: PROVIDER_NAME,
        rank: 0,
        locator: { name, authorized: false, builtin: true },
      })
    }
    return candidates
  }

  /**
   * Read the preset an Agent composes, preferring the exact bound revision.
   * @param {object} agent - live Agent.
   * @returns {string | null} preset id, or null in a preset-free session.
   */
  presetOf(agent) {
    const presets = readService(this.ctx, 'agentPresets')
    if (presets !== undefined) {
      try {
        const composed = presets.composedPreset?.(agent.ctx)
        if (typeof composed === 'string' && composed.length > 0) return composed
      } catch { /* no binding for this context */ }
      try {
        const logged = presets.presetForSession?.(agent.session)
        if (typeof logged === 'string' && logged.length > 0) return logged
      } catch { /* projection not ready */ }
    }
    const header = agent.session?.header?.agentPreset
    return typeof header === 'string' && header.length > 0 ? header : null
  }

  /**
   * Effective authorization for one preset.
   * @param {string | null} presetId - preset identity.
   * @returns {{pool: 'all' | Set<string>, builtinDisabled: Set<string>}} allowed
   *   pool skills, plus the built-in names the role turned off.
   */
  authorizationFor(presetId) {
    const entry = presetId === null ? undefined : this.readAuth().presets?.[presetId]
    const pool = entry !== undefined && Array.isArray(entry.skills)
      ? new Set(entry.skills)
      : this.settings.defaultPolicy === 'all' ? 'all' : new Set()
    return { pool, builtinDisabled: new Set(entry?.builtinDisabled ?? []) }
  }

  /** Drop every cached catalog and let each Agent's provider republish. */
  invalidateAll() {
    this.poolCache = undefined
    this.authCache = undefined
    this.builtinCache.clear()
    for (const record of this.providers.values()) record.invalidate()
  }

  // ── Pool ──────────────────────────────────────────────────────────────────

  /**
   * Current pool entries, parsed from disk and cached briefly so one request
   * step does not rescan per read.
   * @returns {object[]} entries sorted by name.
   */
  poolEntries() {
    const now = Date.now()
    if (this.poolCache !== undefined && now - this.poolCache.at < POOL_CACHE_MS) return this.poolCache.entries
    const entries = scanPool(this.settings.poolDir)
    this.poolCache = { at: now, entries }
    return entries
  }

  /**
   * Read one pool entry by name.
   * @param {string} skillName - kebab-case skill name.
   * @returns {object | undefined} entry, when present and valid.
   */
  poolEntry(skillName) {
    return this.poolEntries().find(entry => entry.name === skillName && entry.error === undefined)
  }

  // ── Authorization state ──────────────────────────────────────────────────

  /**
   * Read the authorization table, invalidated by the file's own stat stamp.
   * @returns {{version: number, presets: Record<string, {skills: string[]}>}}
   */
  readAuth() {
    const file = this.authorizationFile()
    let stamp = 'missing'
    try {
      const stat = statSync(file)
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch { /* absent is valid empty state */ }
    if (this.authCache !== undefined && this.authCache.stamp === stamp) return this.authCache.value
    let value = { version: 1, presets: {} }
    if (stamp !== 'missing') {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        value = normalizeAuth(parsed)
      } catch (error) {
        this.ctx.logger?.warn?.(`skill-hub: authorization file unreadable: ${describe(error)}`)
      }
    }
    this.authCache = { stamp, value }
    return value
  }

  /**
   * Persist one preset's authorization. Omitted fields keep their stored value,
   * so toggling a built-in never rewrites the pool list and vice versa.
   * @param {string} presetId - preset identity.
   * @param {{mode?: 'default'|'list', skills?: string[], builtinDisabled?: string[]}} change - fields to update.
   * @returns {{presetId: string, mode: string, skills: string[], builtinDisabled: string[]}} the stored entry.
   */
  writeAuth(presetId, change) {
    const current = this.readAuth()
    const presets = { ...current.presets }
    const next = { ...presets[presetId] }
    if (change.mode === 'default') delete next.skills
    else if (change.mode === 'list') next.skills = [...new Set(change.skills ?? [])].sort()
    if (change.builtinDisabled !== undefined) {
      if (change.builtinDisabled.length === 0) delete next.builtinDisabled
      else next.builtinDisabled = [...new Set(change.builtinDisabled)].sort()
    }
    if (Object.keys(next).length === 0) delete presets[presetId]
    else presets[presetId] = next
    const table = { version: 1, presets }
    const file = this.authorizationFile()
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${String(process.pid)}`
    writeFileSync(temporary, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    this.authCache = undefined
    this.invalidateAll()
    this.authCache = { stamp: stampOf(file), value: table }
    return {
      presetId,
      mode: Array.isArray(next.skills) ? 'list' : 'default',
      skills: next.skills ?? [],
      builtinDisabled: next.builtinDisabled ?? [],
    }
  }

  /** @returns {string} absolute authorization table path. */
  authorizationFile() {
    return join(this.settings.stateDir, 'authorization.json')
  }

  // ── RPC surface ──────────────────────────────────────────────────────────

  /**
   * Handle one owner-only HTTP request: `{ op, payload }` in, `{ ok, value }`
   * or `{ ok: false, error }` out.
   * @param {Request} request - authenticated POST from the page.
   * @returns {Promise<Response>} JSON response.
   */
  async handleHttp(request) {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { ok: false, error: { code: 'skill-hub/bad-request', message: 'request body is not JSON', details: {} } },
        { status: 400 },
      )
    }
    const op = typeof body?.op === 'string' ? body.op : ''
    const result = await this.handle(op, body?.payload)
    return Response.json(result, { headers: { 'cache-control': 'no-store' } })
  }

  /**
   * Handle one page operation.
   * @param {string} endpoint - operation name.
   * @param {unknown} payload - request payload.
   * @returns {Promise<object>} result envelope.
   */
  async handle(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'snapshot': return { ok: true, value: await this.snapshot() }
        case 'install': return { ok: true, value: this.install(asRecord(payload)) }
        case 'remove': return { ok: true, value: this.remove(asRecord(payload)) }
        case 'authorize': return { ok: true, value: this.authorize(asRecord(payload)) }
        case 'read': return { ok: true, value: this.readSkill(asRecord(payload)) }
        default:
          throw new HubError('skill-hub/unknown-endpoint', `unknown endpoint "${endpoint}"`)
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof HubError ? error.code : 'skill-hub/failed',
          message: describe(error),
          details: {},
        },
      }
    }
  }

  /** Build the complete page snapshot: pool, presets, authorization, built-ins. */
  async snapshot() {
    let entries
    let poolError
    try {
      entries = this.poolEntries()
    } catch (error) {
      entries = []
      poolError = describe(error)
    }
    const presets = await this.presetRows()
    const auth = {}
    for (const preset of presets) {
      const entry = this.readAuth().presets?.[preset.id]
      auth[preset.id] = {
        mode: entry !== undefined && Array.isArray(entry.skills) ? 'list' : 'default',
        skills: entry?.skills ?? [],
        builtinDisabled: entry?.builtinDisabled ?? [],
      }
    }
    const builtin = {}
    for (const preset of presets) builtin[preset.id] = await this.builtinFor(preset.id)
    return {
      poolDir: this.settings.poolDir,
      stateDir: this.settings.stateDir,
      defaultPolicy: this.settings.defaultPolicy,
      hostRevision: HOST_REVISION,
      ...poolError === undefined ? {} : { poolError },
      presets,
      pool: entries.map(entry => ({
        name: entry.name,
        ...entry.declaredName === undefined ? {} : { declaredName: entry.declaredName },
        description: entry.description,
        ...entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse },
        invocation: entry.invocation,
        kind: entry.kind,
        path: entry.path,
        files: entry.files,
        bytes: entry.bytes,
        updatedAt: entry.updatedAt,
        ...entry.error === undefined ? { valid: true } : { valid: false, error: entry.error },
      })),
      auth,
      builtin,
    }
  }

  /** Preset roster with the deployment default marked. */
  async presetRows() {
    const presets = readService(this.ctx, 'agentPresets')
    if (presets === undefined) return []
    let rows = []
    try {
      rows = await presets.list()
    } catch (error) {
      this.ctx.logger?.warn?.(`skill-hub: preset roster unavailable: ${describe(error)}`)
      return []
    }
    let defaultId
    try {
      defaultId = (await presets.resolve()).id
    } catch { /* no usable default */ }
    return rows.map(row => ({
      id: row.id,
      ...row.name === undefined ? {} : { name: row.name },
      ...row.description === undefined ? {} : { description: row.description },
      ...row.broken === undefined ? {} : { broken: row.broken },
      isDefault: row.id === defaultId,
    }))
  }

  /**
   * Skills one preset composes itself (its own providers, e.g. a bundled
   * methodology directory), keyed by name. They are the names a role may turn
   * off; the array form feeds the page.
   * @param {string | null} presetId - preset identity.
   * @returns {Promise<Map<string, object>>} built-in skills, pool shadows excluded.
   */
  async builtinSkills(presetId) {
    if (presetId === null) return new Map()
    const cached = this.builtinCache.get(presetId)
    if (cached !== undefined && Date.now() - cached.at < BUILTIN_CACHE_MS) return cached.value
    const presets = readService(this.ctx, 'agentPresets')
    const registry = readService(this.ctx, 'skills')
    if (presets === undefined || registry === undefined) return new Map()
    /** @type {{key: object, [Symbol.asyncDispose]: () => Promise<void>} | undefined} */
    let lease
    /** @type {Map<string, object>} */
    const value = new Map()
    try {
      lease = await presets.acquireScope(presetId)
      const cwd = readService(this.ctx, 'workingDirectory')?.defaultDirectory
      const listed = await registry.list({ scope: lease.key, ...cwd === undefined ? {} : { cwd } })
      const poolNames = new Set(this.poolEntries().map(entry => entry.name))
      for (const skill of listed) {
        if (skill.provider === PROVIDER_NAME || poolNames.has(skill.name)) continue
        value.set(skill.name, {
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          provider: skill.provider,
          source: skill.source,
          ...skill.path === undefined ? {} : { path: skill.path },
        })
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`skill-hub: built-in skills for "${presetId}" unavailable: ${describe(error)}`)
    } finally {
      try { await lease?.[Symbol.asyncDispose]?.() } catch { /* lease already released */ }
    }
    this.builtinCache.set(presetId, { at: Date.now(), value })
    return value
  }

  /**
   * Built-in skills of one preset as a page list.
   * @param {string | null} presetId - preset identity.
   * @returns {Promise<object[]>} built-in skills.
   */
  async builtinFor(presetId) {
    return [...(await this.builtinSkills(presetId)).values()]
  }

  /**
   * Install one uploaded skill: a single markdown document or a ZIP archive
   * holding one or more `SKILL.md` roots.
   * @param {Record<string, unknown>} payload - `filename` and base64 `data`.
   * @returns {{installed: string[], renamed: {from: string, to: string}[], warnings: string[]}} installed skill names.
   */
  install(payload) {
    const filename = typeof payload.filename === 'string' ? payload.filename : ''
    const encoded = typeof payload.data === 'string' ? payload.data : ''
    if (encoded.length === 0) throw new HubError('skill-hub/empty-upload', 'The uploaded file is empty')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength === 0) throw new HubError('skill-hub/empty-upload', 'The uploaded file is empty')
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new HubError('skill-hub/too-large', `The uploaded file exceeds ${String(Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024))} MiB`)
    }
    const lower = filename.toLowerCase()
    const isZip = lower.endsWith('.zip') || looksLikeZip(bytes)
    const plan = isZip ? skillPlanFromArchive(bytes) : skillPlanFromDocument(bytes, filename)
    if (plan.skills.length === 0) {
      throw new HubError('skill-hub/no-skill', 'No installable skill was found. Upload a SKILL.md or a ZIP containing a SKILL.md.')
    }
    const installed = []
    const renamed = []
    const warnings = []
    for (const skill of plan.skills) {
      try {
        this.installSkill(skill)
        installed.push(skill.name)
        if (skill.declaredName !== undefined) renamed.push({ from: skill.declaredName, to: skill.name })
      } catch (error) {
        warnings.push(`${skill.name}: ${describe(error)}`)
      }
    }
    this.invalidateAll()
    if (installed.length === 0) {
      throw new HubError('skill-hub/install-failed', warnings.join('; ') || 'The skill could not be installed')
    }
    return { installed, renamed, warnings }
  }

  /**
   * Write one planned skill into the pool, replacing an earlier generation.
   * @param {{name: string, files: {path: string, data: Uint8Array}[], flat?: boolean}} skill - plan.
   */
  installSkill(skill) {
    const root = this.poolRoot(skill.name)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (const file of skill.files) {
      const target = containedPath(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data)
    }
    if (!existsSync(join(root, SKILL_FILE))) {
      throw new HubError('skill-hub/missing-skill-file', 'the skill has no SKILL.md')
    }
  }

  /**
   * Remove one pool skill directory.
   * @param {Record<string, unknown>} payload - `name`.
   * @returns {{removed: string}} removed skill name.
   */
  remove(payload) {
    const skillName = requireSkillName(payload.name)
    const root = this.poolRoot(skillName)
    if (!existsSync(root)) throw new HubError('skill-hub/not-found', `No installed skill is named "${skillName}"`)
    rmSync(root, { recursive: true, force: true })
    this.invalidateAll()
    return { removed: skillName }
  }

  /**
   * Store one preset's authorization. `mode`/`skills` address the pool list;
   * `builtinDisabled` addresses the skills the role's own preset composes.
   * Omitted fields keep their stored value.
   * @param {Record<string, unknown>} payload - `presetId`, optional `mode`/`skills`/`builtinDisabled`.
   * @returns {{presetId: string, mode: string, skills: string[], builtinDisabled: string[]}} stored entry.
   */
  authorize(payload) {
    const presetId = typeof payload.presetId === 'string' ? payload.presetId.trim() : ''
    if (!PRESET_ID.test(presetId) || presetId.length > SKILL_NAME_MAX) {
      throw new HubError('skill-hub/invalid-preset', `Invalid agent preset id "${presetId}"`)
    }
    /** @type {{mode?: 'default'|'list', skills?: string[], builtinDisabled?: string[]}} */
    const change = {}
    if (payload.mode === 'default' || payload.mode === 'list') change.mode = payload.mode
    if (payload.skills !== undefined) change.skills = requireSkillNames(payload.skills)
    if (payload.builtinDisabled !== undefined) change.builtinDisabled = requireSkillNames(payload.builtinDisabled)
    if (change.mode === undefined && change.builtinDisabled === undefined) {
      throw new HubError('skill-hub/bad-request', 'authorize needs a pool mode or a built-in list')
    }
    if (change.mode === 'list' && change.skills === undefined) change.skills = []
    return this.writeAuth(presetId, change)
  }

  /**
   * Read one pool skill document for the page's preview.
   * @param {Record<string, unknown>} payload - `name`.
   * @returns {{name: string, path: string, content: string, truncated: boolean}} preview.
   */
  readSkill(payload) {
    const skillName = requireSkillName(payload.name)
    const entry = this.poolEntry(skillName)
    if (entry === undefined) throw new HubError('skill-hub/not-found', `No installed skill is named "${skillName}"`)
    const text = readFileSync(entry.path, 'utf8')
    const truncated = text.length > MAX_PREVIEW_CHARS
    return {
      name: entry.name,
      path: entry.path,
      content: truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text,
      truncated,
    }
  }

  /**
   * Directory that owns one installed skill, guarded against traversal.
   * @param {string} skillName - validated kebab-case name.
   * @returns {string} absolute pool directory for that skill.
   */
  poolRoot(skillName) {
    if (!SKILL_NAME.test(skillName) || skillName.length > SKILL_NAME_MAX) {
      throw new HubError('skill-hub/invalid-skill', `Invalid skill name "${skillName}"`)
    }
    const root = join(this.settings.poolDir, skillName)
    const pool = resolve(this.settings.poolDir)
    if (!resolve(root).startsWith(`${pool}${sep}`)) {
      throw new HubError('skill-hub/invalid-skill', `Skill "${skillName}" resolves outside the pool`)
    }
    return root
  }
}

// ── Pool discovery ─────────────────────────────────────────────────────────

/**
 * Scan a pool directory: one level of `<name>/SKILL.md` bundles plus flat
 * `<name>.md` documents, the same shapes the shipped filesystem provider reads.
 * @param {string} poolDir - absolute pool root.
 * @returns {object[]} entries sorted by name.
 */
function scanPool(poolDir) {
  let dirents
  try {
    dirents = readdirSync(poolDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return []
    throw error
  }
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    const full = join(poolDir, dirent.name)
    if (dirent.isDirectory()) {
      const file = join(full, SKILL_FILE)
      if (!existsSync(file)) continue
      entries.push(readPoolEntry({ path: file, root: full, kind: 'bundle', fallbackName: dirent.name, poolDir }))
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      entries.push(readPoolEntry({
        path: full,
        root: poolDir,
        kind: 'file',
        fallbackName: dirent.name.slice(0, -3),
        poolDir,
      }))
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Parse one pool entry and collect its display facts.
 * @param {{path: string, root: string, kind: 'bundle'|'file', fallbackName: string, poolDir: string}} locator - entry location.
 * @returns {object} pool entry, with `error` when the document is unusable.
 */
function readPoolEntry(locator) {
  const base = {
    name: locator.fallbackName,
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    kind: locator.kind,
    path: locator.path,
    root: locator.root,
    files: locator.kind === 'bundle' ? countFiles(locator.root) : 1,
    bytes: locator.kind === 'bundle' ? totalBytes(locator.root) : fileBytes(locator.path),
    updatedAt: modifiedAt(locator.path),
  }
  let text
  try {
    text = readFileSync(locator.path, 'utf8')
  } catch (error) {
    return { ...base, error: `unreadable: ${describe(error)}` }
  }
  const parsed = parseSkillDocument(text)
  if (!parsed.ok) {
    return { ...base, name: normalizeName(locator.fallbackName), description: firstLine(text), error: parsed.error }
  }
  return {
    ...base,
    name: parsed.name,
    ...parsed.declaredName === undefined ? {} : { declaredName: parsed.declaredName },
    description: parsed.description,
    ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
    invocation: parsed.invocation,
    profile: parsed.profile,
  }
}

function countFiles(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try {
      dirents = readdirSync(current, { withFileTypes: true, encoding: 'utf8' })
    } catch { continue }
    for (const dirent of dirents) {
      const full = join(current, dirent.name)
      if (dirent.isDirectory()) stack.push(full)
      else if (dirent.isFile()) total += 1
      if (total > 5000) return total
    }
  }
  return total
}

function totalBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try {
      dirents = readdirSync(current, { withFileTypes: true, encoding: 'utf8' })
    } catch { continue }
    for (const dirent of dirents) {
      const full = join(current, dirent.name)
      try {
        if (dirent.isDirectory()) stack.push(full)
        else if (dirent.isFile()) total += statSync(full).size
      } catch { /* vanished entry */ }
    }
  }
  return total
}

function modifiedAt(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function fileBytes(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function firstLine(text) {
  const line = text.replace(/^\uFEFF/, '').split('\n').map(value => value.trim()).find(value => value.length > 0 && value !== '---')
  return line === undefined ? '' : line.slice(0, 200)
}

// ── Skill document parsing ─────────────────────────────────────────────────

/**
 * Parse `SKILL.md`: YAML frontmatter plus the instruction body.
 * @param {string} text - file contents.
 * @returns {{ok: true, name: string, description: string, whenToUse?: string, invocation: {modelInvocable: boolean, userInvocable: boolean}, content: string, profile?: object} | {ok: false, error: string}}
 */
export function parseSkillDocument(text) {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (match === null) return { ok: false, error: 'missing YAML frontmatter (--- … ---)' }
  let data
  try {
    data = parseFrontmatterYaml(match[1])
  } catch (error) {
    return { ok: false, error: `invalid YAML frontmatter: ${describe(error)}` }
  }
  const declaredName = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  const name = canonicalSkillName(declaredName)
  if (name === undefined) {
    return {
      ok: false,
      error: `frontmatter "name" must be letters or digits with "-" or "_" (got "${declaredName}")`,
    }
  }
  if (description.length === 0) return { ok: false, error: 'frontmatter "description" is required' }
  const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim().length > 0
    ? data.whenToUse.trim()
    : undefined
  const modelDisabled = readBoolean(data['disable-model-invocation'])
  const userDisabled = readBoolean(data['user-invocable'])
  if (modelDisabled === 'invalid') return { ok: false, error: 'frontmatter "disable-model-invocation" must be a boolean' }
  if (userDisabled === 'invalid') return { ok: false, error: 'frontmatter "user-invocable" must be a boolean' }
  const body = normalized.slice(match[0].length)
  return {
    ok: true,
    name,
    ...declaredName === name ? {} : { declaredName },
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: {
      modelInvocable: modelDisabled !== true,
      userInvocable: userDisabled !== false,
    },
    content: body.trim(),
    profile: {
      disableModelInvocation: modelDisabled === true,
      userInvocable: userDisabled !== false,
    },
  }
}

/**
 * Minimal YAML mapping reader for skill frontmatter: plain and quoted scalars,
 * block scalars, booleans, and nested maps kept as raw text.
 * @param {string} source - frontmatter body.
 * @returns {Record<string, unknown>} parsed keys.
 */
function parseFrontmatterYaml(source) {
  const data = {}
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (/^\s*(?:#|$)/.test(line)) {
      index += 1
      continue
    }
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]
    const rest = match[2]
    if (rest.length === 0) {
      // Nested block (metadata, unknown keys): keep the raw indented text.
      const block = []
      index += 1
      while (index < lines.length && (/^[ \t]+\S/.test(lines[index]) || /^[ \t]*$/.test(lines[index]))) {
        block.push(lines[index])
        index += 1
      }
      data[key] = block.join('\n').trim()
      continue
    }
    if (/^[|>][+-]?$/.test(rest.trim())) {
      const folded = rest.trim().startsWith('>')
      const block = []
      index += 1
      let indent
      while (index < lines.length) {
        const current = lines[index]
        if (current.trim().length === 0) {
          block.push('')
          index += 1
          continue
        }
        const width = /^[ \t]*/.exec(current)[0].length
        if (indent === undefined) indent = width
        if (width < indent) break
        block.push(current.slice(indent))
        index += 1
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop()
      data[key] = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n')
      continue
    }
    data[key] = parseScalar(rest)
    index += 1
  }
  return data
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value.length === 0) return ''
  if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
    return value.slice(1, -1).replaceAll("\\\"", '"')
  }
  const withoutComment = value.replace(/\s+#.*$/, '')
  return withoutComment.trim()
}

function readBoolean(value) {
  if (value === undefined || value === '') return undefined
  const text = typeof value === 'boolean' ? String(value) : String(value).trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return 'invalid'
}

// ── Upload plans ──────────────────────────────────────────────────────────

/**
 * Build an install plan from a single markdown document.
 * @param {Buffer} bytes - uploaded bytes.
 * @param {string} filename - original file name.
 * @returns {{skills: object[]}} plan with one skill.
 */
function skillPlanFromDocument(bytes, filename) {
  const text = bytes.toString('utf8')
  const parsed = parseSkillDocument(text)
  if (!parsed.ok) {
    throw new HubError('skill-hub/invalid-skill', `${filename || SKILL_FILE}: ${parsed.error}`)
  }
  return {
    skills: [{
      name: parsed.name,
      ...parsed.declaredName === undefined ? {} : { declaredName: parsed.declaredName },
      files: [{ path: SKILL_FILE, data: bytes }],
    }],
  }
}

/**
 * Build an install plan from a ZIP archive: every directory holding a
 * `SKILL.md` is one skill, and a lone markdown document is one flat skill.
 * @param {Buffer} bytes - archive bytes.
 * @returns {{skills: object[]}} plan.
 */
function skillPlanFromArchive(bytes) {
  const members = readZip(bytes)
  const files = []
  let unpacked = 0
  for (const member of members) {
    const path = sanitizeArchivePath(member.path)
    if (path === undefined) continue
    if (path === '.DS_Store' || path.endsWith('/.DS_Store') || path.startsWith('__MACOSX/')) continue
    unpacked += member.data.byteLength
    if (member.data.byteLength > MAX_ENTRY_BYTES) {
      throw new HubError('skill-hub/too-large', `"${path}" exceeds the per-file limit`)
    }
    if (unpacked > MAX_UNPACKED_BYTES) {
      throw new HubError('skill-hub/too-large', 'The archive expands beyond the unpacked size limit')
    }
    files.push({ path, data: member.data })
  }
  const roots = new Set()
  for (const file of files) {
    const segments = file.path.split('/')
    if (segments[segments.length - 1] === SKILL_FILE) roots.add(segments.slice(0, -1).join('/'))
  }
  if (roots.size === 0) {
    const documents = files.filter(file => file.path.toLowerCase().endsWith('.md'))
    if (documents.length !== 1) {
      throw new HubError('skill-hub/no-skill', 'The archive contains no SKILL.md and no single markdown document')
    }
    const document = documents[0]
    return skillPlanFromDocument(Buffer.from(document.data), document.path)
  }
  const skills = []
  const seen = new Set()
  // One file belongs to the deepest skill root above it, so a SKILL.md at the
  // archive root never swallows a nested skill directory.
  const rootList = [...roots]
  const rootPrefixOf = (path) => {
    let best
    for (const root of rootList) {
      const prefix = root.length === 0 ? '' : `${root}/`
      if (!path.startsWith(prefix)) continue
      if (best === undefined || prefix.length > best.length) best = prefix
    }
    return best
  }
  for (const root of rootList) {
    const prefix = root.length === 0 ? '' : `${root}/`
    const owned = files.filter(file => rootPrefixOf(file.path) === prefix)
    const document = owned.find(file => file.path === `${prefix}${SKILL_FILE}`)
    if (document === undefined) continue
    const parsed = parseSkillDocument(Buffer.from(document.data).toString('utf8'))
    if (!parsed.ok) {
      throw new HubError('skill-hub/invalid-skill', `${prefix}${SKILL_FILE}: ${parsed.error}`)
    }
    if (seen.has(parsed.name)) {
      throw new HubError('skill-hub/duplicate-skill', `The archive installs "${parsed.name}" twice`)
    }
    seen.add(parsed.name)
    skills.push({
      name: parsed.name,
      ...parsed.declaredName === undefined ? {} : { declaredName: parsed.declaredName },
      files: owned.map(file => ({
        path: file.path.slice(prefix.length),
        data: file.data,
      })),
    })
  }
  return { skills }
}

/**
 * Normalize one archive member path.
 * @param {string} raw - archive-declared path.
 * @returns {string | undefined} safe relative slash path, or undefined to skip it.
 */
function sanitizeArchivePath(raw) {
  const path = raw.replaceAll('\\', '/').replace(/^\/+/, '')
  if (path.length === 0) return undefined
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return undefined
    if (segment.includes('\0') || segment.includes(':')) return undefined
  }
  return segments.join('/')
}

/**
 * Resolve one planned file inside a skill root.
 * @param {string} root - absolute skill directory.
 * @param {string} relative - planned archive-relative path.
 * @returns {string} absolute target path proven to stay inside `root`.
 */
function containedPath(root, relative) {
  const target = resolve(root, relative)
  if (target !== resolve(root) && !target.startsWith(`${resolve(root)}${sep}`)) {
    throw new HubError('skill-hub/invalid-path', `Archive member escapes the skill directory: "${relative}"`)
  }
  return target
}

// ── ZIP reader ────────────────────────────────────────────────────────────

/**
 * Read a stored/deflated ZIP archive into memory.
 * @param {Buffer} buffer - archive bytes.
 * @returns {{path: string, data: Buffer}[]} member files.
 */
export function readZip(buffer) {
  if (buffer.byteLength < 22) throw new HubError('skill-hub/invalid-zip', 'The archive is too short to be a ZIP file')
  const endOffset = findEndOfCentralDirectory(buffer)
  if (endOffset < 0) throw new HubError('skill-hub/invalid-zip', 'The archive has no ZIP central directory')
  const count = buffer.readUInt16LE(endOffset + 10)
  const directorySize = buffer.readUInt32LE(endOffset + 12)
  const directoryOffset = buffer.readUInt32LE(endOffset + 16)
  if (count > MAX_ZIP_ENTRIES) throw new HubError('skill-hub/invalid-zip', `The archive holds more than ${String(MAX_ZIP_ENTRIES)} entries`)
  if (directoryOffset + directorySize > buffer.byteLength) {
    throw new HubError('skill-hub/invalid-zip', 'The ZIP central directory is outside the archive')
  }
  const members = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.byteLength || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new HubError('skill-hub/invalid-zip', 'The ZIP central directory is malformed')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const memberName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (memberName.endsWith('/')) continue
    if ((flags & 0x1) !== 0) throw new HubError('skill-hub/invalid-zip', 'Encrypted ZIP entries are not supported')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new HubError('skill-hub/invalid-zip', 'ZIP64 archives are not supported')
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new HubError('skill-hub/too-large', `"${memberName}" exceeds the per-file limit`)
    }
    if (localOffset + 30 > buffer.byteLength || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new HubError('skill-hub/invalid-zip', `The local header for "${memberName}" is malformed`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.byteLength) {
      throw new HubError('skill-hub/invalid-zip', `The data for "${memberName}" is outside the archive`)
    }
    const raw = buffer.subarray(dataStart, dataEnd)
    if (method === 0) {
      members.push({ path: memberName, data: Buffer.from(raw) })
    } else if (method === 8) {
      let inflated
      try {
        inflated = inflateRawSync(raw)
      } catch (error) {
        throw new HubError('skill-hub/invalid-zip', `"${memberName}" could not be decompressed: ${describe(error)}`)
      }
      if (inflated.byteLength > MAX_ENTRY_BYTES) {
        throw new HubError('skill-hub/too-large', `"${memberName}" exceeds the per-file limit`)
      }
      members.push({ path: memberName, data: inflated })
    } else {
      throw new HubError('skill-hub/invalid-zip', `"${memberName}" uses unsupported compression method ${String(method)}`)
    }
  }
  return members
}

/**
 * Locate the end-of-central-directory record.
 * @param {Buffer} buffer - archive bytes.
 * @returns {number} record offset, or -1.
 */
function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.byteLength - 66_000)
  for (let offset = buffer.byteLength - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function looksLikeZip(buffer) {
  return buffer.byteLength >= 4 && buffer.readUInt32LE(0) === 0x04034b50
}

// ── Small helpers ─────────────────────────────────────────────────────────

/**
 * Look a service up through a Context without requiring an `inject` declaration.
 * @param {object} ctx - Cordis context.
 * @param {string} service - service name.
 * @returns {any} the service, or undefined.
 */
function readService(ctx, service) {
  try {
    return ctx.get(service)
  } catch {
    return undefined
  }
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function requireSkillName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!SKILL_NAME.test(name) || name.length > SKILL_NAME_MAX) {
    throw new HubError('skill-hub/invalid-skill', `Invalid skill name "${name}"`)
  }
  return name
}

/**
 * Validate a list of skill names from a request payload.
 * @param {unknown} value - proposed names.
 * @returns {string[]} validated, deduplicated names.
 */
function requireSkillNames(value) {
  if (!Array.isArray(value)) throw new HubError('skill-hub/invalid-skill', 'skill names must be a list')
  const names = []
  for (const candidate of value) {
    const name = requireSkillName(candidate)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function normalizeName(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, SKILL_NAME_MAX)
}

/**
 * Normalize a declared skill name to the registry's kebab-case grammar:
 * lowercase, every `.`/`_` (and repeated separator) becomes one `-`.
 * @param {unknown} raw - `name` from the frontmatter.
 * @returns {string | undefined} canonical name, or undefined when unusable.
 */
export function canonicalSkillName(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0 || text.length > DECLARED_NAME_MAX || !DECLARED_NAME.test(text)) return undefined
  const canonical = text.toLowerCase().replaceAll(/[._]+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-+|-+$/g, '')
  if (!SKILL_NAME.test(canonical) || canonical.length > SKILL_NAME_MAX) return undefined
  return canonical
}

function normalizeAuth(parsed) {
  const presets = {}
  const source = parsed !== null && typeof parsed === 'object' ? parsed.presets : undefined
  const names = (value) => (Array.isArray(value)
    ? [...new Set(value.filter(name => typeof name === 'string' && SKILL_NAME.test(name)))].sort()
    : undefined)
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [presetId, entry] of Object.entries(source)) {
      if (!PRESET_ID.test(presetId)) continue
      const record = entry !== null && typeof entry === 'object' ? entry : {}
      /** @type {{skills?: string[], builtinDisabled?: string[]}} */
      const normalized = {}
      // An existing `skills` array is an explicit pool list, even when empty.
      if ('skills' in record) normalized.skills = names(record.skills) ?? []
      const disabled = names(record.builtinDisabled)
      if (disabled !== undefined && disabled.length > 0) normalized.builtinDisabled = disabled
      if (Object.keys(normalized).length > 0) presets[presetId] = normalized
    }
  }
  return { version: 1, presets }
}

function stampOf(file) {
  try {
    const stat = statSync(file)
    return `${String(stat.mtimeMs)}:${String(stat.size)}`
  } catch {
    return 'missing'
  }
}

function describe(error) {
  if (error instanceof HubError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

function hasCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Pure helpers reused by the workspace tests; not part of the plugin contract. */
export const __internal = {
  SkillHub,
  resolveSettings,
  canonicalSkillName,
  parseSkillDocument,
  parseFrontmatterYaml,
  readZip,
  scanPool,
  skillPlanFromArchive,
  skillPlanFromDocument,
  sanitizeArchivePath,
  normalizeAuth,
}
