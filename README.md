# my-dsh-skill-hub

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

在左侧栏新增 **技能** 入口：一个全局共享的技能池，加上按 agent 预设授权的管理页。

## 功能

- **外部技能池**：技能放在 `<dshHome>/skills`（默认即 `%USERPROFILE%\.dsh\skills`，也就是 `skill-filesystem` 的 `user-dsh` 根）。安装方式两种：
  - 单个 `SKILL.md`（或任意 `.md`，需带 `name` / `description` frontmatter）；
  - ZIP 压缩包：包内每个含 `SKILL.md` 的目录各算一个技能，支持一次装多个。
  - `name` 可以写 `team_notes`、`Team.Notes` 这类形式：DSH 的技能注册表和 `skill` 工具只接受 kebab-case，所以安装时会规范化为 `team-notes`（`_`、`.`、连续分隔符都并成 `-`，统一小写），页面会标注「原名 …」，安装提示里也会说明。`/` 菜单与 `skill` 工具都要用规范化后的名字。
- **按预设授权（两套维度）**：授权表存于 `<dshHome>/skill-hub/authorization.json`，每个预设一条记录：
  - `skills`：该角色可用的**外部技能**；缺省时沿用默认策略 `defaultPolicy`（默认 `all`）。
  - `builtinDisabled`：该角色**系统内置**的技能里被停用的名字（缺省为空 = 全启用）。它们同样在 provider 里以 `modelInvocable:false, userInvocable:false` 的影子条目压掉，所以「不使用某个内置技能」是真实生效的，而不只是界面状态。
- **强制生效**：每个 Agent 创建时，插件通过 `agent.ctx.skills.registerProvider()` 在该 Agent 的 scope 层注册一个 provider。被授权的池内技能按真实 invocation 策略列出；未授权的池内技能、以及被停用的内置技能都以影子条目返回——影子在层叠中压过全局/预设层的同名技能，因此既不出现在模型技能目录里，也不出现在 `/` 菜单里，`skill` 工具加载时报「不可用于模型调用」。
- **角色显示名**：内置角色（`standard` / `ptc` / `minimal` / `cordis`）在页面显示为「标准模式 / PTC 模式 / 极简模式 / 创造模式」（英文界面为 Standard / PTC / Minimal / Creator mode）；自定义角色用它自己的名字。

## 页面

- 顶部：**刷新**、**上传安装**（也可把文件拖到页面上）。
- **角色授权**：选择角色（内置角色显示中文名）；右上角显示「当前角色已授权 X/X 个外部技能，X/X 个系统内置技能」；有显式授权时提供 `恢复默认策略`（同时清空外部技能授权与内置技能停用记录）。
- **外部技能** 与 **系统内置技能**：都是**两列卡片**；每张卡片右上角是授权开关（外部技能 = 授权给该角色；内置技能 = 该角色是否启用），卡片内还有描述、事实信息（目录/单文件、文件数、体积、原名）与操作。
- 两个区块头部各有一组 `全部允许` / `全部取消`，作用于当前角色的对应技能集合。
- 外部技能卡片：**预览** 展开 `SKILL.md` 原文；**删除** 需要二次确认；无效技能（frontmatter 缺 name/description 等）仍会列出并标注原因。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 技能池与授权表的根 |
| `poolDir` | `<dshHome>/skills` | 技能池目录 |
| `stateDir` | `<dshHome>/skill-hub` | 授权表目录 |
| `defaultPolicy` | `all` | 未显式授权的预设的可选值：`all` 或 `none` |

## 第三方组件

- [`marked`](https://github.com/markedjs/marked) v12.0.2（MIT）—— `vendor/marked.min.js`，仅用于技能预览里的 markdown 渲染；加载失败时退回纯文本。
- [`dompurify`](https://github.com/cure53/DOMPurify) v3.4.18（Apache-2.0 / MPL-2.0 双许可）—— `vendor/purify.min.js`，用于对预览渲染结果做白名单清洗；许可证全文见 `vendor/purify.LICENSE`。

## 已知边界

- 卸载本插件后，授权不再被强制执行；池中的技能文件仍在磁盘上，是否可见取决于各预设自己的 `skill-filesystem` 配置。
- 外部直接改磁盘上的技能文件，会在下一次技能读取后生效（池扫描有约 1.5 秒缓存）；页面上的操作会立即失效缓存。
- 上传限制：单文件 12 MiB、ZIP 解压后 64 MiB、单条目 8 MiB；ZIP64 与加密条目不支持。
- 授权按「预设」记账，不在会话内重新校验；给某个 Agent 追加授权后，其下一个请求步骤的目录会更新。
- Host 侧代码在应用进程内不会热替换：升级本插件的 `host.js` 后需要重启应用（页面底部会显示 Host 版本，用于确认）。


## 预览安全

技能预览渲染的是**第三方上传包里的 SKILL.md**，属于不可信内容，因此渲染分两步：

1. `marked` 把 Markdown 转成 HTML（GFM 表格、代码块、列表、标题都照旧，代码块保留 `language-*` class）；
2. `DOMPurify`（`vendor/purify.min.js`，3.4.18，Apache-2.0 / MPL-2.0）按白名单清洗后再插入 DOM：
   - 保留：标题、段落、列表、表格、引用、`pre/code`、`details/summary`、`a[href]`（限 http/https/mailto/相对路径）、`img[src]`（含 `data:image/*`）；
   - 移除：`script`、`style`、`iframe`、`object`、`embed`、`form` 等标签，以及所有 `on*` 事件属性、`style` 属性、`javascript:` 链接。

DOMPurify 不可用时**退回转义纯文本**（不再使用正则黑名单）。`vendor` 操作只允许 `marked.min.js` 与 `purify.min.js` 两个文件名。
