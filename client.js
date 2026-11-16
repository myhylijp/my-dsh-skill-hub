/**
 * Skill hub — Client half.
 *
 * Adds the **Skills** entry to the left sidebar and the page it opens in the
 * main column. The page reads and writes the Host half over the package-private
 * `/api/skill-hub` route: the global pool, the preset roster, the per-preset
 * authorization table (pool skills and built-in skills), and read-only facts
 * about the skills a preset composes itself.
 *
 * Both skill groups render as a two-column card grid. A card's authorization
 * switch sits at its right edge: for a pool skill it grants the skill to the
 * selected role, and for a built-in skill it turns that role's own skill off.
 *
 * Rendered with plain `React.createElement` on purpose: a plugin bundle must
 * not import Harness Client packages, so the controls below are local copies of
 * the host's capsule-button, switch, and card patterns, styled with the
 * `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'my-dsh-skill-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'skillHub'
    /** Id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'skills'
    /** Host route carrying the page's JSON requests; see `host.js`. */
    const ROUTE = 'api/skill-hub'
    /** Pool uploads larger than this are refused before reading the file. */
    const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
    /**
     * Visible build marker. A browser keeps the bundle it already loaded, so the
     * page states which build it runs: bump this whenever the Client half changes.
     */
    const UI_REVISION = '2026-11-14.11'

    const zh = {
      panel: '技能',
      'page.title': '技能',
      'page.lead': '技能统一在共享池中维护；每个 agent 预设只使用被授权的技能，未授权的技能不会出现在该角色的技能目录里，模型也无法加载。',
      'actions.upload': '上传安装',
      'actions.refresh': '刷新',
      'actions.preview': '预览',
      'actions.hidePreview': '收起',
      'actions.remove': '删除',
      'actions.confirm': '确认删除',
      'actions.cancel': '取消',
      'actions.retry': '重试',
      'actions.dismiss': '关闭提示',
      'actions.resetPolicy': '恢复默认策略',
      'actions.grantAll': '全部允许',
      'actions.revokeAll': '全部取消',
      'actions.grantOne': '允许当前角色使用技能 {name}',
      'busy.installing': '正在安装…',
      'busy.refreshing': '正在刷新…',
      'busy.previewing': '读取中…',
      'section.presets': '角色授权',
      'section.pool': '外部技能',
      'section.builtin': '系统内置技能',
      'preset.standard': '标准模式',
      'preset.ptc': 'PTC 模式',
      'preset.minimal': '极简模式',
      'preset.cordis': '创造模式',
      'presets.empty': '没有可用的 agent 预设，无法授权。',
      'state.loading': '正在读取技能池…',
      'state.failed': '技能页暂时无法读取：',
      'preset.default': '默认',
      'badge.broken': '角色不可用',
      'badge.off': '已停用',
      'policy.default': '当前沿用默认策略：{policy}',
      'policy.all': '所有技能都允许',
      'policy.none': '默认不允许，需逐个授权',
      'policy.list': '按勾选授权（新安装的技能需手动勾选）',
      'policy.granted': '当前角色已授权 {poolGranted}/{poolTotal} 个外部技能，{builtinGranted}/{builtinTotal} 个系统内置技能',
      'pool.empty': '还没有安装任何外部技能。上传一个 SKILL.md，或包含 SKILL.md 的 ZIP 压缩包即可安装。',
      'pool.drop': '松开即可安装',
      'pool.invalid': '无法使用',
      'pool.files': '{files} 个文件',
      'pool.declared': '原名 {name}',
      'builtin.needsRestart': '按角色开关内置技能需要重启应用后生效（当前 Host 版本较旧）。',
      'builtin.empty': '该角色的插件组合没有提供系统内置技能。',
      'builtin.source': '来源：{provider}',
      'kind.bundle': '目录',
      'kind.file': '单文件',
      'badge.manual': '仅手动调用',
      'badge.builtin': '内置',
      'notice.installed': '已安装：{names}',
      'notice.overwritten': '已覆盖安装：{names}（原目录中的其他文件已移除）',
      'notice.removed': '已删除技能 {name}',
      'notice.renamed': '名称已规范化为：{pairs}',
      'notice.saved': '授权已保存',
      'notice.savedNoRefresh': '授权已保存，但列表刷新失败：{message}',
      'notice.explicit': '已改为按勾选授权。',
      'error.fileTooLarge': '文件超过 {limit} MiB，请改用在服务器上放置目录的方式安装。',
      'err.failed': '操作失败',
      'err.http': '无法连接 Harness 服务（页面或服务可能已重启），请刷新后再试',
      'err.invalid-skill': 'SKILL.md 的 frontmatter 无效：需要 name（字母/数字，可用 “-” 或 “_” 分隔）与非空 description',
      'err.no-skill': '上传内容里没有可安装的技能：请上传 SKILL.md，或包含 SKILL.md 的 ZIP',
      'err.too-large': '文件或解压后体积超过上限',
      'err.invalid-zip': 'ZIP 压缩包无法解析（不支持 ZIP64 与加密条目）',
      'err.invalid-preset': '角色标识无效',
      'err.not-found': '找不到这个技能，可能已被删除',
      'err.unknown-endpoint': '请求不被支持，请刷新页面',
      'err.empty-upload': '上传的文件是空的',
      'err.bad-request': '请求格式无效，请刷新页面',
      'err.invalid-path': '压缩包里的路径不合法',
      'err.missing-file': '技能目录里缺少 SKILL.md',
      'err.duplicate-skill': '压缩包里同一个技能出现了两次',
      'foot.poolDir': '技能池目录',
    }

    const en = {
      panel: 'Skills',
      'page.title': 'Skills',
      'page.lead': 'Skills are kept in one shared pool. Each agent preset uses only the skills it is granted; an unauthorized skill is absent from that role’s skill catalog and cannot be loaded by the model.',
      'actions.upload': 'Install',
      'actions.refresh': 'Refresh',
      'actions.preview': 'Preview',
      'actions.hidePreview': 'Hide',
      'actions.remove': 'Remove',
      'actions.confirm': 'Delete',
      'actions.cancel': 'Cancel',
      'actions.retry': 'Retry',
      'actions.dismiss': 'Dismiss',
      'actions.resetPolicy': 'Use the default policy',
      'actions.grantAll': 'Grant all',
      'actions.revokeAll': 'Revoke all',
      'actions.grantOne': 'Allow this role to use skill {name}',
      'busy.installing': 'Installing…',
      'busy.refreshing': 'Refreshing…',
      'busy.previewing': 'Reading…',
      'section.presets': 'Role authorization',
      'section.pool': 'External skills',
      'section.builtin': 'System built-in skills',
      'preset.standard': 'Standard mode',
      'preset.ptc': 'PTC mode',
      'preset.minimal': 'Minimal mode',
      'preset.cordis': 'Creator mode',
      'presets.empty': 'No agent presets are available, so nothing can be granted.',
      'state.loading': 'Reading the skill pool…',
      'state.failed': 'The Skills page could not read its data:',
      'preset.default': 'default',
      'badge.broken': 'role unavailable',
      'badge.off': 'off',
      'policy.default': 'Following the default policy: {policy}',
      'policy.all': 'everything is allowed',
      'policy.none': 'nothing is allowed until granted',
      'policy.list': 'Granted per skill (skills installed later must be granted too)',
      'policy.granted': 'This role may use {poolGranted}/{poolTotal} external skills and {builtinGranted}/{builtinTotal} system built-in skills',
      'pool.empty': 'No external skills are installed yet. Install a SKILL.md or a ZIP archive that contains one.',
      'pool.drop': 'Drop to install',
      'pool.invalid': 'unusable',
      'pool.files': '{files} files',
      'pool.declared': 'named {name}',
      'builtin.needsRestart': 'Per-role built-in switches need a newer Host; restart the app to use them.',
      'builtin.empty': 'This role’s own plugins provide no system built-in skills.',
      'builtin.source': 'From {provider}',
      'kind.bundle': 'Bundle',
      'kind.file': 'Single file',
      'badge.manual': 'manual only',
      'badge.builtin': 'built-in',
      'notice.installed': 'Installed: {names}',
      'notice.overwritten': 'Replaced: {names} (files that were only in the old directory are gone)',
      'notice.removed': 'Removed skill {name}',
      'notice.renamed': 'Normalized names: {pairs}',
      'notice.saved': 'Authorization saved',
      'notice.savedNoRefresh': 'Authorization saved, but the list could not be refreshed: {message}',
      'notice.explicit': 'This role now grants skills individually.',
      'error.fileTooLarge': 'The file exceeds {limit} MiB. Install it by placing the directory on the host instead.',
      'err.failed': 'The operation failed',
      'err.http': 'The Harness service could not be reached (the page or service may have restarted). Reload and try again.',
      'err.invalid-skill': 'The SKILL.md frontmatter is invalid: it needs a name (letters/digits, "-" or "_" separators) and a non-empty description',
      'err.no-skill': 'Nothing installable was found: upload a SKILL.md, or a ZIP containing one',
      'err.too-large': 'The file or its unpacked size exceeds the limit',
      'err.invalid-zip': 'The ZIP archive could not be read (ZIP64 and encrypted entries are unsupported)',
      'err.invalid-preset': 'Invalid role identity',
      'err.not-found': 'No such skill; it may have been removed',
      'err.unknown-endpoint': 'Unsupported request; reload the page',
      'err.empty-upload': 'The uploaded file is empty',
      'err.bad-request': 'Malformed request; reload the page',
      'err.invalid-path': 'The archive contains an invalid path',
      'err.missing-file': 'The skill directory has no SKILL.md',
      'err.duplicate-skill': 'The archive installs one skill twice',
      'foot.poolDir': 'Skill pool directory',
    }

    const CSS = `
.sh-page{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.sh-page *{box-sizing:border-box}
.sh-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
/* Same column geometry as the native Plugins/Schedules pages: a 960px content
   column with the inset OUTSIDE it, so the text width and page margins match. */
.sh-page .sh-inner{box-sizing:border-box;max-width:none;margin:0 auto;padding:28px 48px 48px}
/* macOS hiddenInset titlebar: the native pages add the frame's top clearance. */
[data-platform='darwin'] .sh-page .sh-inner{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.sh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:0}
.sh-title{margin:0;font-size:20px;line-height:28px;font-weight:500}
.sh-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.sh-lead{margin:0 0 20px;max-width:72ch;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.sh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.sh-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sh-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sh-btn:disabled{opacity:.5;cursor:default}
.sh-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.sh-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.sh-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.sh-btn-ghost:hover{color:var(--dsw-alias-label-primary)}
.sh-btn-link{height:auto;padding:2px 4px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.sh-btn-link:hover{background:none;color:var(--dsw-alias-brand-primary)}
.sh-btn-danger{color:var(--dsw-alias-state-error-primary)}
.sh-btn-danger:hover{color:var(--dsw-alias-state-error-primary)}
.sh-toast-layer{position:absolute;right:clamp(24px,4vw,48px);bottom:20px;z-index:20;display:flex;justify-content:flex-end;pointer-events:none}
.sh-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:10px;max-width:min(460px,calc(100vw - 80px));padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.08);font-size:13px;line-height:1.5;animation:sh-toast-in .18s ease-out}
.sh-toast-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.sh-toast-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,transparent);color:var(--dsw-alias-state-error-primary)}
.sh-toast-text{min-width:0;overflow-wrap:anywhere}
.sh-toast-close{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.sh-toast-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.sh-toast-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@keyframes sh-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.sh-toast{animation:none}}
.sh-card{margin-bottom:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sh-card-drop{outline:1.5px dashed var(--dsw-alias-brand-primary);outline-offset:-4px}
.sh-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.sh-card-title{margin:0;font-size:14.5px;font-weight:500}
.sh-card-note{color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right}
.sh-card-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;min-width:0}
.sh-card-tools{display:flex;align-items:center;gap:2px;flex:none}
.sh-card-body{padding:14px 16px}
.sh-chips{display:flex;flex-wrap:wrap;gap:8px}
.sh-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.sh-chip:hover{color:var(--dsw-alias-label-primary)}
.sh-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sh-chip[aria-pressed="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.sh-policy{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:12px;border-top:.5px dashed var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.sh-policy-actions{display:flex;align-items:center;gap:8px}
.sh-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px 16px}
@media (max-width:760px){.sh-grid{grid-template-columns:minmax(0,1fr)}}
.sh-item{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.sh-item-off{opacity:.72}
.sh-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.sh-item-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;font-size:13.5px;font-weight:500}
.sh-item-title code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12.5px;font-weight:500;overflow-wrap:anywhere}
.sh-item-desc{margin:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;color:var(--dsw-alias-label-secondary);font-size:12.5px;overflow-wrap:anywhere}
.sh-item-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;opacity:.85;overflow-wrap:anywhere}
.sh-item-foot{display:flex;align-items:center;gap:4px;margin-top:auto}
.sh-badge{padding:1px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;white-space:nowrap}
.sh-badge-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}
.sh-confirm{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.sh-switch{position:relative;flex:none;align-self:flex-start;width:36px;height:20px;padding:0;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.sh-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
.sh-switch[aria-checked="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary)}
.sh-switch[aria-checked="true"]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}
.sh-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sh-switch:disabled{opacity:.5;cursor:default}
.sh-preview{margin:0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sh-empty{padding:18px 16px;color:var(--dsw-alias-label-secondary);font-size:13px}
.sh-warn{color:var(--dsw-alias-state-warn-primary)}
.sh-foot{margin:18px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.sh-version{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;opacity:.7}
.sh-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:40px;color:var(--dsw-alias-label-secondary);font-size:13.5px;text-align:center}
.sh-center-error{color:var(--dsw-alias-state-error-primary)}
`

    let boundTranslate = () => ''

    /**
     * Resolve a dictionary key with `{name}` interpolation.
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string} localized text, or the key when the dictionary is silent.
     */
    function fallbackTranslate(key, params) {
      let text = key
      try { text = boundTranslate(key, params) } catch { /* dictionaries not installed yet */ }
      return text
    }

    /** Host failure codes mapped to localized copy. */
    const ERROR_KEYS = {
      'skill-hub/failed': 'err.failed',
      'skill-hub/invalid-skill': 'err.invalid-skill',
      'skill-hub/no-skill': 'err.no-skill',
      'skill-hub/too-large': 'err.too-large',
      'skill-hub/invalid-zip': 'err.invalid-zip',
      'skill-hub/invalid-preset': 'err.invalid-preset',
      'skill-hub/not-found': 'err.not-found',
      'skill-hub/unknown-endpoint': 'err.unknown-endpoint',
      'skill-hub/empty-upload': 'err.empty-upload',
      'skill-hub/bad-request': 'err.bad-request',
      'skill-hub/invalid-path': 'err.invalid-path',
      'skill-hub/missing-skill-file': 'err.missing-file',
      'skill-hub/duplicate-skill': 'err.duplicate-skill',
      'skill-hub/transport': 'err.http',
    }

    /**
     * Localize one failure, keeping the raw Host message only when it says
     * something the code does not.
     * @param {Function} tr - translator.
     * @param {unknown} error - failure from a request.
     * @returns {string} user-facing text.
     */
    function localizedError(tr, error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      const key = typeof code === 'string' ? ERROR_KEYS[code] : undefined
      const message = error instanceof Error ? error.message : String(error)
      if (key === undefined) return message.length > 0 ? message : tr('err.failed')
      return message.length > 0 && message !== key ? `${tr(key)}（${message}）` : tr(key)
    }

    /**
     * Call one Host operation over the package's owner-only route.
     * @param {string} op - operation name.
     * @param {Record<string, unknown>} [payload] - request payload.
     * @returns {Promise<any>} the operation value.
     */
    function createRequest() {
      return async function request(op, payload) {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, payload: payload ?? {} }),
        })
        if (!response.ok) {
          const failure = new Error(`HTTP ${String(response.status)}`)
          failure.code = 'skill-hub/transport'
          throw failure
        }
        let result
        try {
          result = await response.json()
        } catch {
          const failure = new Error('response body is not JSON')
          failure.code = 'skill-hub/transport'
          throw failure
        }
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          const failure = new Error(result?.error?.message ?? `operation "${op}" failed`)
          if (typeof result?.error?.code === 'string') failure.code = result.error.code
          throw failure
        }
        return result.value
      }
    }

    /**
     * Read one selected file as base64 (the request body is JSON).
     * @param {File} file - selected file.
     * @returns {Promise<string>} base64 payload without the data-URL prefix.
     */
    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => { reject(new Error('file read error')) }
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : ''
          const comma = result.indexOf(',')
          resolve(comma < 0 ? '' : result.slice(comma + 1))
        }
        reader.readAsDataURL(file)
      })
    }

    /** Shipped role display names; the roster carries no name for these. */
    const PRESET_NAME_KEYS = {
      standard: 'preset.standard',
      ptc: 'preset.ptc',
      minimal: 'preset.minimal',
      cordis: 'preset.cordis',
    }

    /**
     * Display name for one role: a localized name for the shipped roles, the
     * role's own name for a custom one, else its id.
     * @param {Function} tr - translator.
     * @param {object} preset - roster row.
     * @returns {string} display name.
     */
    function presetLabel(tr, preset) {
      const key = PRESET_NAME_KEYS[preset.id]
      if (key !== undefined) return tr(key)
      return typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : preset.id
    }

    /**
     * Render one global-pool skill as a card: title row with the authorization
     * switch at its right edge, description, facts, and the card's own actions.
     * @param {object} props - entry, state, and callbacks.
     * @returns {object} React element.
     */
    function PoolCard(props) {
      const { entry, allowed, busy, tr, preview, confirming, canAuthorize, reading } = props
      const manualOnly = entry.invocation?.modelInvocable === false
      const open = preview !== null && preview.name === entry.name
      const meta = entry.valid === false
        ? (entry.error ?? '')
        : [
          entry.declaredName === undefined ? undefined : tr('pool.declared', { name: entry.declaredName }),
          entry.kind === 'file' ? tr('kind.file') : tr('kind.bundle'),
          tr('pool.files', { files: entry.files }),
          formatBytes(entry.bytes),
        ].filter(part => part !== undefined).join(' · ')
      return h('article', { className: `sh-item${allowed ? '' : ' sh-item-off'}` },
        h('div', { className: 'sh-item-head' },
          h('div', { className: 'sh-item-title' },
            h('code', null, entry.name),
            manualOnly ? h('span', { className: 'sh-badge' }, tr('badge.manual')) : null,
            entry.valid === false ? h('span', { className: 'sh-badge sh-badge-warn' }, tr('pool.invalid')) : null,
            allowed ? null : h('span', { className: 'sh-badge' }, tr('badge.off')),
          ),
          h('button', {
            type: 'button',
            className: 'sh-switch',
            role: 'switch',
            'aria-checked': allowed ? 'true' : 'false',
            'aria-label': tr('actions.grantOne', { name: entry.name }),
            disabled: busy || entry.valid === false || canAuthorize !== true,
            onClick: () => props.onToggle(entry.name, !allowed),
          }),
        ),
        h('p', { className: 'sh-item-desc' }, entry.description || (entry.error ?? '')),
        h('div', { className: 'sh-item-meta' }, meta),
        open ? h('pre', {
          className: 'sh-preview',
          tabIndex: 0,
          role: 'region',
          'aria-label': entry.name,
        }, preview.content) : null,
        h('div', { className: 'sh-item-foot' },
          confirming === entry.name
            ? h('span', { className: 'sh-confirm' },
              h('button', { type: 'button', className: 'sh-btn sh-btn-link sh-btn-danger', disabled: busy, onClick: () => props.onRemove(entry.name) }, tr('actions.confirm')),
              h('button', { type: 'button', className: 'sh-btn sh-btn-link', disabled: busy, onClick: () => props.onCancelRemove() }, tr('actions.cancel')),
            )
            : [
              entry.valid === false ? null : h('button', {
                key: 'preview',
                type: 'button',
                className: 'sh-btn sh-btn-link',
                disabled: busy,
                onClick: () => props.onPreview(entry.name),
              }, reading ? tr('busy.previewing') : open ? tr('actions.hidePreview') : tr('actions.preview')),
              h('button', {
                key: 'remove',
                type: 'button',
                className: 'sh-btn sh-btn-link',
                disabled: busy,
                onClick: () => props.onAskRemove(entry.name),
              }, tr('actions.remove')),
            ],
        ),
      )
    }

    /**
     * Render one built-in skill as a card. It is part of the role's own
     * composition, so the switch turns it off for this role instead of
     * granting a pool skill.
     * @param {object} props - entry, state, and callbacks.
     * @returns {object} React element.
     */
    function BuiltinCard(props) {
      const { entry, allowed, busy, tr, canAuthorize } = props
      return h('article', { className: `sh-item${allowed ? '' : ' sh-item-off'}` },
        h('div', { className: 'sh-item-head' },
          h('div', { className: 'sh-item-title' },
            h('code', null, entry.name),
            h('span', { className: 'sh-badge' }, tr('badge.builtin')),
            allowed ? null : h('span', { className: 'sh-badge sh-badge-warn' }, tr('badge.off')),
          ),
          h('button', {
            type: 'button',
            className: 'sh-switch',
            role: 'switch',
            'aria-checked': allowed ? 'true' : 'false',
            'aria-label': tr('actions.grantOne', { name: entry.name }),
            disabled: busy || canAuthorize !== true,
            onClick: () => props.onToggle(entry.name, !allowed),
          }),
        ),
        h('p', { className: 'sh-item-desc' }, entry.description),
        h('div', { className: 'sh-item-meta' }, tr('builtin.source', { provider: entry.provider })),
      )
    }

    /**
     * The Skills panel: pool cards, per-role authorization, built-in switches,
     * and the install control.
     * @param {object} props - framework slot props plus the injected request.
     * @returns {object} React element.
     */
    function SkillHubPage(props) {
      const request = props.requestSkillHub
      const requestRef = React.useRef(request)
      requestRef.current = request
      const tr = React.useCallback((key, params) => (typeof props.t === 'function' ? props.t(key, params) : fallbackTranslate(key, params)), [props.t])
      const [snapshot, setSnapshot] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(null)
      const [presetId, setPresetId] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)
      const inputRef = React.useRef(null)
      const snapshotRef = React.useRef(null)
      const trRef = React.useRef(tr)
      trRef.current = tr

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const value = await requestRef.current('snapshot', {})
          snapshotRef.current = value
          setSnapshot(value)
          setLoadError(null)
          setPresetId(current => {
            const presets = Array.isArray(value.presets) ? value.presets : []
            if (current !== null && presets.some(preset => preset.id === current)) return current
            const fallback = presets.find(preset => preset.isDefault) ?? presets[0]
            return fallback === undefined ? null : fallback.id
          })
          return true
        } catch (error) {
          const text = localizedError(trRef.current, error)
          setLoadError(text)
          // A failed refresh keeps the last good list on screen, so the failure
          // must be visible instead of leaving stale data looking current.
          if (snapshotRef.current !== null) {
            setNotice({ kind: 'error', text: `${trRef.current('state.failed')} ${text}` })
          }
          return false
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => {
        if (notice === null || notice.kind !== 'ok') return undefined
        const timer = setTimeout(() => { setNotice(null) }, 5000)
        return () => { clearTimeout(timer) }
      }, [notice])

      const pool = Array.isArray(snapshot?.pool) ? snapshot.pool : []
      const presets = Array.isArray(snapshot?.presets) ? snapshot.presets : []
      const validPool = pool.filter(entry => entry.valid !== false)
      const authEntry = (presetId !== null && snapshot?.auth?.[presetId]) || { mode: 'default', skills: [], builtinDisabled: [] }
      const explicit = authEntry.mode === 'list' ? new Set(authEntry.skills) : null
      const policyAll = snapshot?.defaultPolicy === 'all'
      const isAllowed = (name) => (explicit === null ? policyAll : explicit.has(name))
      const grantedCount = validPool.filter(entry => isAllowed(entry.name)).length
      const selectedPreset = presets.find(preset => preset.id === presetId) ?? null
      const builtin = (presetId !== null && snapshot?.builtin?.[presetId]) || []
      const builtinDisabled = new Set(Array.isArray(authEntry.builtinDisabled) ? authEntry.builtinDisabled : [])
      const isBuiltinAllowed = (name) => !builtinDisabled.has(name)
      const enabledBuiltinCount = builtin.filter(entry => isBuiltinAllowed(entry.name)).length
      // A running Harness keeps the Host modules it loaded. Detect the capability
      // from the data instead of a version string: a Host that supports per-role
      // built-in switches reports `builtinDisabled` on every authorization entry.
      const builtinControlsReady = Object.values(snapshot?.auth ?? {}).some(entry =>
        entry !== null && typeof entry === 'object' && Object.hasOwn(entry, 'builtinDisabled'))
      // Names this role may use now, including authorized names whose files are
      // currently invalid: toggling one skill must not silently drop the rest.
      const currentlyAllowed = explicit !== null
        ? [...explicit]
        : policyAll ? validPool.map(entry => entry.name) : []

      const saveAuthorization = async (skills) => {
        if (presetId === null) return
        const wasDefault = authEntry.mode !== 'list'
        setBusy('authorize')
        try {
          await requestRef.current('authorize', { presetId, mode: 'list', skills })
          const refreshed = await load()
          setNotice({
            kind: 'ok',
            text: refreshed
              ? wasDefault ? `${tr('notice.saved')} ${tr('notice.explicit')}` : tr('notice.saved')
              : tr('notice.savedNoRefresh', { message: tr('state.failed') }),
          })
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const resetAuthorization = async () => {
        if (presetId === null) return
        setBusy('authorize')
        try {
          await requestRef.current('authorize', { presetId, mode: 'default', builtinDisabled: [] })
          const refreshed = await load()
          setNotice({
            kind: 'ok',
            text: refreshed ? tr('notice.saved') : tr('notice.savedNoRefresh', { message: tr('state.failed') }),
          })
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const saveBuiltins = async (disabled) => {
        if (presetId === null) return
        setBusy('authorize')
        try {
          await requestRef.current('authorize', { presetId, builtinDisabled: disabled })
          const refreshed = await load()
          setNotice({
            kind: 'ok',
            text: refreshed ? tr('notice.saved') : tr('notice.savedNoRefresh', { message: tr('state.failed') }),
          })
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const toggleSkill = (name, next) => {
        const nextSet = new Set(currentlyAllowed)
        if (next) nextSet.add(name)
        else nextSet.delete(name)
        void saveAuthorization([...nextSet])
      }

      const toggleBuiltin = (name, next) => {
        const nextSet = new Set(builtinDisabled)
        if (next) nextSet.delete(name)
        else nextSet.add(name)
        void saveBuiltins([...nextSet])
      }

      const grantAll = () => {
        void saveAuthorization([...new Set([...currentlyAllowed, ...validPool.map(entry => entry.name)])])
      }
      const revokeAll = () => { void saveAuthorization([]) }

      const installFile = async (file) => {
        if (file === undefined || file === null) return
        if (file.size > MAX_UPLOAD_BYTES) {
          setNotice({ kind: 'error', text: tr('error.fileTooLarge', { limit: Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024) }) })
          return
        }
        const before = new Set(pool.map(entry => entry.name))
        setBusy('install')
        try {
          const data = await readFileBase64(file)
          const value = await requestRef.current('install', { filename: file.name, data })
          const installed = Array.isArray(value.installed) ? value.installed : []
          const warnings = Array.isArray(value.warnings) ? value.warnings : []
          const renamed = Array.isArray(value.renamed) ? value.renamed : []
          const replaced = installed.filter(name => before.has(name))
          const fresh = installed.filter(name => !before.has(name))
          const parts = []
          if (fresh.length > 0) parts.push(tr('notice.installed', { names: fresh.join(', ') }))
          if (replaced.length > 0) parts.push(tr('notice.overwritten', { names: replaced.join(', ') }))
          if (renamed.length > 0) {
            parts.push(tr('notice.renamed', {
              pairs: renamed.map(pair => `${pair.from} → ${pair.to}`).join(', '),
            }))
          }
          if (warnings.length > 0) parts.push(warnings.join('; '))
          setNotice({ kind: warnings.length > 0 ? 'error' : 'ok', text: parts.join(' ') })
          await load()
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const onFileChosen = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        void installFile(file)
      }

      const onDrop = (event) => {
        event.preventDefault()
        setDragging(false)
        void installFile(event.dataTransfer?.files?.[0])
      }

      const togglePreview = async (name) => {
        if (preview !== null && preview.name === name) {
          setPreview(null)
          return
        }
        setBusy(`read:${name}`)
        try {
          const value = await requestRef.current('read', { name })
          setPreview(value)
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const removeSkill = async (name) => {
        setConfirming(null)
        setBusy(`remove:${name}`)
        try {
          await requestRef.current('remove', { name })
          if (preview !== null && preview.name === name) setPreview(null)
          setNotice({ kind: 'ok', text: tr('notice.removed', { name }) })
          await load()
        } catch (error) {
          setNotice({ kind: 'error', text: localizedError(tr, error) })
        } finally {
          setBusy(null)
        }
      }

      const style = h('style', null, CSS)

      if (loading && snapshot === null) {
        return h('div', { className: 'sh-page' }, style,
          h('div', { className: 'sh-center' },
            h('span', null, tr('state.loading')),
            h('span', { className: 'sh-version' }, `Skills UI v${UI_REVISION}`),
          ),
        )
      }

      if (loadError !== null && snapshot === null) {
        return h('div', { className: 'sh-page' }, style,
          h('div', { className: 'sh-center sh-center-error' },
            h('span', null, `${tr('state.failed')} ${loadError}`),
            h('button', { type: 'button', className: 'sh-btn', onClick: () => { void load() } }, tr('actions.retry')),
            h('span', { className: 'sh-version' }, `Skills UI v${UI_REVISION}`),
          ),
        )
      }

      return h('div', {
        className: 'sh-page',
        onDragOver: (event) => { event.preventDefault(); setDragging(true) },
        onDragLeave: () => { setDragging(false) },
        onDrop,
      },
      style,
      h('div', { className: 'sh-scroll' },
        h('div', { className: 'sh-inner' },
          h('header', { className: 'sh-head' },
            h('h1', { className: 'sh-title' }, tr('page.title')),
            h('div', { className: 'sh-head-actions' },
              h('button', {
                type: 'button',
                className: 'sh-btn sh-btn-ghost',
                disabled: loading,
                onClick: () => { void load() },
              }, loading ? tr('busy.refreshing') : tr('actions.refresh')),
              h('button', {
                type: 'button',
                className: 'sh-btn sh-btn-primary',
                disabled: busy === 'install',
                onClick: () => { inputRef.current?.click() },
              }, busy === 'install' ? tr('busy.installing') : tr('actions.upload')),
              h('input', {
                ref: inputRef,
                type: 'file',
                accept: '.md,.zip,text/markdown,application/zip',
                style: { display: 'none' },
                onChange: onFileChosen,
              }),
            ),
          ),
          h('p', { className: 'sh-lead' }, tr('page.lead')),
          h('section', { className: 'sh-card' },
            h('div', { className: 'sh-card-head' },
              h('h2', { className: 'sh-card-title' }, tr('section.presets')),
              presetId === null
                ? null
                : h('span', { className: 'sh-card-note' }, tr('policy.granted', {
                  poolGranted: grantedCount,
                  poolTotal: validPool.length,
                  builtinGranted: enabledBuiltinCount,
                  builtinTotal: builtin.length,
                })),
            ),
            h('div', { className: 'sh-card-body' },
              presets.length === 0
                ? h('div', { className: 'sh-empty' }, tr('presets.empty'))
                : h('div', { className: 'sh-chips' }, presets.map(preset => h('button', {
                  key: preset.id,
                  type: 'button',
                  className: 'sh-chip',
                  'aria-pressed': preset.id === presetId ? 'true' : 'false',
                  'aria-describedby': preset.broken === undefined ? undefined : `sh-broken-${preset.id}`,
                  title: preset.broken ?? preset.id,
                  onClick: () => { setPresetId(preset.id); setPreview(null); setConfirming(null) },
                },
                presetLabel(tr, preset),
                preset.isDefault ? h('span', { className: 'sh-badge' }, tr('preset.default')) : null,
                preset.broken === undefined
                  ? null
                  : h('span', { className: 'sh-badge sh-badge-warn', id: `sh-broken-${preset.id}` }, tr('badge.broken')),
                ))),
              h('div', { className: 'sh-policy' },
                h('span', null, authEntry.mode === 'list'
                  ? tr('policy.list')
                  : tr('policy.default', {
                    policy: policyAll ? tr('policy.all') : tr('policy.none'),
                  })),
                presetId !== null && (authEntry.mode === 'list' || builtinDisabled.size > 0)
                  ? h('div', { className: 'sh-policy-actions' },
                    h('button', {
                      type: 'button',
                      className: 'sh-btn sh-btn-link',
                      disabled: busy !== null,
                      onClick: () => { void resetAuthorization() },
                    }, tr('actions.resetPolicy')),
                  )
                  : null,
              ),
            ),
          ),
          h('section', {
            className: `sh-card${dragging ? ' sh-card-drop' : ''}`,
          },
          h('div', { className: 'sh-card-head' },
            h('h2', { className: 'sh-card-title' }, tr('section.pool')),
            h('div', { className: 'sh-card-actions' },
              dragging ? h('span', { className: 'sh-card-note' }, tr('pool.drop')) : null,
              presetId === null ? null : h('div', { className: 'sh-card-tools' },
                h('button', {
                  type: 'button',
                  className: 'sh-btn sh-btn-link',
                  disabled: busy !== null || grantedCount === validPool.length,
                  onClick: grantAll,
                }, tr('actions.grantAll')),
                h('button', {
                  type: 'button',
                  className: 'sh-btn sh-btn-link',
                  disabled: busy !== null || grantedCount === 0,
                  onClick: revokeAll,
                }, tr('actions.revokeAll')),
              ),
            ),
          ),
          pool.length === 0
            ? h('div', { className: 'sh-empty' }, tr('pool.empty'))
            : h('div', { className: 'sh-grid' }, pool.map(entry => h(PoolCard, {
              key: entry.name,
              entry,
              allowed: entry.valid !== false && isAllowed(entry.name),
              busy: busy !== null,
              reading: busy === `read:${entry.name}`,
              tr,
              preview,
              confirming,
              canAuthorize: presetId !== null,
              onToggle: toggleSkill,
              onPreview: (name) => { void togglePreview(name) },
              onAskRemove: (name) => { setConfirming(name) },
              onCancelRemove: () => { setConfirming(null) },
              onRemove: (name) => { void removeSkill(name) },
            }))),
          ),
          h('section', { className: 'sh-card' },
            h('div', { className: 'sh-card-head' },
              h('h2', { className: 'sh-card-title' }, tr('section.builtin')),
              h('div', { className: 'sh-card-actions' },
                presetId === null || !builtinControlsReady ? null : h('div', { className: 'sh-card-tools' },
                  h('button', {
                    type: 'button',
                    className: 'sh-btn sh-btn-link',
                    disabled: busy !== null || enabledBuiltinCount === builtin.length,
                    onClick: () => { void saveBuiltins([]) },
                  }, tr('actions.grantAll')),
                  h('button', {
                    type: 'button',
                    className: 'sh-btn sh-btn-link',
                    disabled: busy !== null || enabledBuiltinCount === 0,
                    onClick: () => { void saveBuiltins(builtin.map(entry => entry.name)) },
                  }, tr('actions.revokeAll')),
                ),
              ),
            ),
            selectedPreset?.broken === undefined
              ? null
              : h('div', { className: 'sh-empty sh-warn' }, selectedPreset.broken),
            builtinControlsReady
              ? null
              : h('div', { className: 'sh-empty sh-warn' }, tr('builtin.needsRestart')),
            builtin.length === 0
              ? h('div', { className: 'sh-empty' }, tr('builtin.empty'))
              : h('div', { className: 'sh-grid' }, builtin.map(entry => h(BuiltinCard, {
                key: entry.name,
                entry,
                allowed: isBuiltinAllowed(entry.name),
                busy: busy !== null,
                tr,
                canAuthorize: presetId !== null && builtinControlsReady,
                onToggle: toggleBuiltin,
              }))),
          ),
          h('p', { className: 'sh-foot' }, tr('foot.poolDir'), ' ', h('code', null, snapshot?.poolDir ?? '')),
          h('p', { className: 'sh-foot sh-version' }, `Skills UI v${UI_REVISION} · Host v${snapshot?.hostRevision ?? '?'}`),
        ),
      ),
      // Floating toast: it overlays the page instead of taking a row, so saving
      // an authorization never shifts the layout under the pointer.
      notice === null ? null : h('div', { className: 'sh-toast-layer' },
        h('div', {
          className: `sh-toast ${notice.kind === 'ok' ? 'sh-toast-ok' : 'sh-toast-error'}`,
          role: notice.kind === 'ok' ? 'status' : 'alert',
        },
        h('span', { className: 'sh-toast-text' }, notice.text),
        h('button', {
          type: 'button',
          className: 'sh-toast-close',
          'aria-label': tr('actions.dismiss'),
          title: tr('actions.dismiss'),
          onClick: () => { setNotice(null) },
        }, '×'),
        ),
      ),
      )
    }

    /**
     * The sidebar glyph: a bound manual with a bookmark, drawn in currentColor.
     * @param {object} props - `size` requested by the sidebar row.
     * @returns {object} React element.
     */
    function SkillHubIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, [
        h('path', { key: 'w', d: 'M4 20 L14.4 9.6' }),
        h('path', { key: 't', d: 'M14.4 9.6 l1.3 -1.3 a1.12 1.12 0 0 1 1.58 1.58 l-1.3 1.3 z' }),
        h('path', { key: 's1', d: 'M18.4 2.6 l1.05 2.35 2.35 1.05 -2.35 1.05 -1.05 2.35 -1.05 -2.35 -2.35 -1.05 2.35 -1.05z' }),
        h('path', { key: 's2', d: 'M7.2 3.8 l0.75 1.65 1.65 0.75 -1.65 0.75 -0.75 1.65 -0.75 -1.65 -1.65 -0.75 1.65 -0.75z' }),
        h('path', { key: 's3', d: 'M18.6 15.4 l0.6 1.3 1.3 0.6 -1.3 0.6 -0.6 1.3 -0.6 -1.3 -1.3 -0.6 1.3 -0.6z' }),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-hub: dictionaries')
        boundTranslate = ctx.locale.bind(NS)
        const t = boundTranslate
        const request = createRequest()
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ requestSkillHub: request }),
        }, SkillHubPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: -20,
          locale: NS,
          label: () => t('panel'),
        }, SkillHubIcon))
      },
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }
  },
})
