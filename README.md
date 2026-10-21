# English Notebook · 英文批注与翻译

浏览器扩展 + 本地同步服务：在任意网页选中英文，**右键「翻译并记录」**，右侧滑出批注栏，原文出现彩色波浪线；在已有波浪线里再选短语，会叠出**另一种颜色的嵌套波浪线**。批注按页面绑定，数据写进一个 JSON 文件，由本地服务自动 `git commit`。

## 架构

```
选中英文 → 右键「翻译并记录」
        ↓
content script：采集选区、判断父批注、生成文本锚点
        ↓
background service worker：调用翻译 Provider → 写入 chrome.storage.local
        ↓
sync-server（Node，127.0.0.1:17890）：读写用户指定绝对路径的 JSON 文件
        ↓
数据文件所在 git 仓库：写入后 4s debounce 自动 commit（不 push）
```

- 扩展和同步服务之间用 HTTP + JSON；服务未启动时扩展仍可本地使用，启动后自动合并。
- 批注只显示在**记录时所在的那个页面**（URL 规范化后完全一致）。
- 波浪线颜色按嵌套层级循环：琥珀 → 绿 → 蓝 → 紫 → 粉 → 青，超过 6 层循环。

## 功能

- **原生右键菜单**（真正的浏览器扩展，`chrome.contextMenus`）：`翻译并记录`、`仅记录`；`Alt+T` 快捷键等效。
- **Word 式批注栏**：右侧卡片显示原文、译文、备注；可编辑译文、朗读、定位原文、删除；嵌套批注缩进并用对应颜色标记。
- **批注跟随页面滚动**：每张卡片按它对应波浪线在页面里的位置纵向对齐，滚动页面时同步移动；位置重叠自动错开，滚出视口自动隐藏；鼠标在批注栏上滚动也会带着网页一起滚。
- **彩色波浪线**：`text-decoration: underline wavy`，嵌套层级颜色不同；点击波浪线跳到对应批注卡片。
- **按页面绑定**：刷新页面后按「原文 + 出现序号」重新定位并恢复波浪线。
- **分组**：分组可绑定域名（子域自动匹配），记录时自动归入第一个匹配分组；设置页可随时移动。
- **设置/管理页**：同步状态与路径、翻译 Provider、分组增删改、全部批注搜索/改译文/换组/删除、JSON 导入导出。
- **本地 git 同步**：数据文件自动创建、自动 `git commit`、增量合并（同 id 取 `updatedAt` 较新者）。
- **翻译 Provider**：MyMemory（默认免费）/ Google 免 Key / OpenAI 兼容接口 / 自定义 HTTP 接口 / 关闭自动翻译。

## 安装

前置：安装 Node.js（`start-sync.bat` 会自动从 PATH、`%ProgramFiles%\nodejs`、`D:\nodejs` 里找 `node.exe`）。

1. **加载扩展**：Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）→ 打开「开发人员模式」→「加载解压缩的扩展」→ 选择本仓库的 `extension/` 目录。
2. **启动同步服务**：双击 `sync-server/start-sync.bat`（或仓库根执行 `node sync-server/sync-server.mjs`）。
3. **设置数据文件**：第一次在网页右键记录时，扩展会弹窗要求填写数据文件的**绝对路径**，例如：
   - `C:\Users\你的用户名\Documents\english-notebook\data\english-notes.json`，或任意目录下的新文件（父目录需存在，文件会自动创建）。
   - 也可以随时在扩展设置页（`Alt+M` 或扩展详情 → 扩展选项）填写并点「保存地址并连接」。
4. 在网页上选中一段英文 → 右键 →「翻译并记录」→ 右侧出现批注栏。

> 同步服务没启动也没关系：批注先存浏览器本地，弹窗会提示；启动服务后到设置页点「立即同步」即可合并。

## 使用

| 操作 | 说明 |
| --- | --- |
| 右键 → 翻译并记录 | 翻译选中文本并生成批注（`Alt+T` 同效） |
| 右键 → 仅记录 | 只记原文，译文稍后手动补 |
| 批注栏 | 右侧边缘「批注 N」标签，或 `Alt+O` |
| 设置 / 全部记录 | `Alt+M`，或扩展详情 → 扩展选项 |
| `Esc` | 关闭批注栏 / 弹窗 |

**嵌套批注**：在一段已有波浪线的文字里再选一个短语右键记录，会自动作为子批注（不同颜色的波浪线、批注栏里缩进）。删除父批注会级联删除子批注。

## 数据与同步

数据文件结构（v2）：

```json
{
  "version": 2,
  "updatedAt": "2026-10-18T15:00:00.000Z",
  "groups": [
    { "id": "g_xxx", "name": "BBC 新闻", "hosts": ["bbc.com"], "createdAt": "...", "updatedAt": "..." }
  ],
  "items": [
    {
      "id": "i_xxx",
      "groupId": "g_xxx",
      "text": "The committee has yet to reach a decision.",
      "translation": "委员会尚未作出决定。",
      "note": "",
      "pageUrl": "https://www.bbc.com/news/...",
      "pageTitle": "BBC News",
      "sourceHost": "bbc.com",
      "anchor": { "text": "The committee has yet to reach a decision.", "occurrence": 0, "prefix": "…", "suffix": "…" },
      "parentId": null,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

同步服务（`sync-server/sync-server.mjs`）：

| 接口 | 说明 |
| --- | --- |
| `GET /health` | `{ok, server, version, configured, dataFile, git}` |
| `GET /config` | 当前 `{dataFile, autoCommit, debounceMs}` |
| `POST /config` | `{dataFile}` 设置绝对路径；自动创建空文件；持久化到 `sync-server/sync-config.json`（已 gitignore） |
| `GET /state` | `{revision, state}`；未配置返回 409 |
| `PUT /state` | 与服务端现有文件合并后写回，返回合并后的完整 `state` 与 `revision` |

合并规则：按 `id` 比较 `updatedAt`，较新者胜出；新增项追加；旧版本计入 `skipped`；父批注悬空/跨页/成环会被自动修复。git 提交只包含数据文件，提交失败静默降级（非 git 仓库时只写文件）。

## 翻译 Provider

设置页 → 翻译 Provider：

- **MyMemory**（默认）：免费、无需 Key，可能限流。
- **Google Translate 免 Key 接口**：国内网络通常不可用。
- **OpenAI 兼容接口**：填 Base URL / API Key / 模型，可接官方、中转或兼容服务。
- **自定义 HTTP 接口**：GET 用 `{{text}}`、`{{lang}}` 占位；POST 用 body 模板 + 结果字段路径（如 `data.translation`）；可加自定义 headers。
- **关闭**：只记录原文，译文手动补。

翻译失败不会丢记录：先保存原文并在页面提示，之后在批注栏点 ✎ 补译文。

## 开发与测试

```powershell
node --test tests/          # 全部单元/集成测试
node tests/serve.mjs        # 打印 PORT，供浏览器打开 tests/*.html 冒烟页
```

测试构成：

- `tests/core.test.mjs`：数据模型、页面 URL 规范化、嵌套父批注校验、合并导入（12 条）。
- `tests/sync-server.test.mjs`：同步服务 HTTP 契约、绝对路径校验、落盘、合并、git 自动提交（6 条）。
- `tests/background.test.mjs`：用 Node VM 模拟 chrome API，联调 background ↔ 真实 sync-server。
- `tests/render-smoke.html`：浏览器里验证嵌套波浪线、颜色、跨标签节点匹配、选区父级识别。
- `tests/content-smoke.html`：用 chrome API 桩加载真实 `content.js`，验证 UI 注入、批注栏、卡片缩进、toast、选区采集。
- `tests/comment-scroll-smoke.html`：验证批注卡片随页面滚动精确位移（滚动 60px → 卡片 top 同步 -60px）。

无头浏览器冒烟（Edge/Chrome）：

```powershell
node tests/serve.mjs   # 记下 PORT
msedge --headless=new --disable-gpu --no-sandbox --user-data-dir=%TEMP%\enb-profile `
  --virtual-time-budget=9000 --dump-dom http://127.0.0.1:PORT/tests/render-smoke.html
# 输出里搜 data-smoke
```

> 无头模式不支持加载扩展；扩展本身用「有头 Edge + 测试页回传结果」或 Node 联调测试验证。`tests/extension-smoke.html` 用有头方式加载 `extension/` 后访问，可检查内容脚本是否注入。

## 文件结构

```
extension/
  manifest.json      Manifest V3（contextMenus / storage / tabs / <all_urls>）
  core.js            数据模型与合并逻辑（UMD，扩展与 Node 复用）
  render.js          批注渲染引擎：波浪线、嵌套、文本锚点、选区采集
  background.js      后台：右键菜单、翻译 Provider、存储、同步客户端
  content.js         页面内 UI：批注栏、首次路径弹窗、toast、快捷键、SPA 监听
  options.html/js    设置与批注管理页
sync-server/
  sync-server.mjs    本地 HTTP 同步服务 + git 自动提交
  start-sync.bat     双击启动
data/
  english-notes.json 仓库内默认数据文件示例
tests/               单元测试、服务/后台集成测试、浏览器冒烟页
legacy-userscript/   旧版油猴脚本（v0.1，已归档）
```

## 已知限制

- **波浪线依赖文本锚点**：页面文案改版、无限滚动/重渲染、跨 iframe 或 Shadow DOM 的内容可能无法恢复；刷新页面会重新尝试。`pre/code`、输入框、可编辑区域不标注。
- **批注只在本页显示**：同一网站的其他页面不会出现（按 URL 规范化后精确匹配）。
- **嵌套颜色循环**：最多 6 层颜色循环、20 层上限。
- **翻译依赖第三方接口**：可能限流/超时；国内访问 Google 接口通常失败，建议用 MyMemory 或自备 OpenAI 兼容/自定义接口。
- **同步服务需手动启动**：不启动时扩展只写浏览器本地存储，不会进 git；多设备同时编辑同一批注时按更新时间取新，可能覆盖旧内容（冲突方内容会丢）。
- **数据规模**：`chrome.storage.local` 和全文 JSON 文件适合万条以内批注，不适合超大词库。
- **权限**：扩展声明 `<all_urls>` 以在任何网页注入批注 UI，浏览器会提示「读取和更改所有网站的数据」；数据仅本地存储/本地服务，无遥测。

## 旧版

`legacy-userscript/` 是 v0.1 油猴版本（按网站分组的笔记 + 手动导出 JSON），保留作参考；新功能全部在 `extension/` 中。
