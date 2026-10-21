# English Notebook · 英文批注与翻译

浏览器扩展：在任意网页选中英文，**右键「翻译并记录」**，右侧滑出批注栏，原文出现彩色波浪线；在已有波浪线里再选短语，会叠出**另一种颜色的嵌套波浪线**。批注按页面绑定，数据直接读写你用系统文件选择器指定的 JSON 文件（File System Access API），**不需要本地服务，也不做 git commit/push**。

## 架构

```
选中英文 → 右键「翻译并记录」
        ↓
content script：采集选区、判断父批注、生成文本锚点
        ↓
background service worker：翻译 / 存储 / 消息路由
        ↓
File System Access：直接读写你选择的 JSON 文件
（文件可以放在 OneDrive / 坚果云等同步目录，用网盘同步）
```

- 不需要启动任何本地服务；扩展自己直接读写文件。
- 批注只显示在**记录时所在的那个页面**（URL 规范化后完全一致）。
- 波浪线颜色按嵌套层级循环：琥珀 → 绿 → 蓝 → 紫 → 粉 → 青，超过 6 层循环。

## 功能

- **原生右键菜单**（真正的浏览器扩展，`chrome.contextMenus`）：`翻译并记录`、`仅记录`；`Alt+T` 快捷键等效。
- **Word 式批注栏**：右侧卡片显示原文、译文、备注；可编辑译文、朗读、定位原文、删除；嵌套批注缩进并用对应颜色标记。
- **批注跟随页面滚动**：每张卡片按它对应波浪线在页面里的位置纵向对齐，滚动页面时同步移动；位置重叠自动错开，滚出视口自动隐藏；鼠标在批注栏上滚动也会带着网页一起滚。
- **彩色波浪线**：`text-decoration: underline wavy`，嵌套层级颜色不同；点击波浪线跳到对应批注卡片。
- **按页面绑定**：刷新页面后按「原文 + 出现序号」重新定位并恢复波浪线。
- **分组**：分组可绑定域名（子域自动匹配），记录时自动归入第一个匹配分组；设置页可随时移动。
- **设置/管理页**：数据文件选择与状态、翻译 Provider、分组增删改、全部批注搜索/改译文/换组/删除、JSON 导入导出。
- **本地文件直读写**：用系统文件选择器授权一个 JSON 文件，扩展直接读写；不经过本地服务，也不做 git，文件可放 OneDrive/坚果云同步目录。
- **翻译 Provider**：MyMemory（默认免费）/ Google 免 Key / OpenAI 兼容 / DeepSeek（与 AI 审查共用配置）/ 自定义 HTTP 接口 / 关闭自动翻译。
- **AI 审查（与翻译共用同一份 LLM 配置）**：批注卡片点 🧠，先写下自己的中文翻译，AI 会点评并提取不熟悉的单词 / 词组 / 固定用法，保存到本机。
- **美音朗读**：批注卡片、AI 提取的词/词组、复习卡片都有「🔊 美音」按钮，优先选择 en-US 的 Microsoft Natural / Google US English 语音朗读。
- **内置 PDF 阅读器**：PDF 页面点扩展图标 →「用内置 PDF 阅读器打开」，用 pdf.js 渲染出可选中文字层；右键/气泡「记录选中」、波浪线、批注栏、AI 审查、美音朗读都能用，批注绑定原始 PDF 地址。
- **常驻复习气泡**：页面右下角 📚 气泡，点开可「复习 / 批注栏 / 设置」；复习按 单词 / 词组 / 固定用法 分类，卡片翻面、标记已记住。

## 安装

不需要安装 Node.js，也不需要启动 sync-server。

1. **加载扩展**：Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）→ 打开「开发人员模式」→「加载解压缩的扩展」→ 选择本仓库的 `extension/` 目录。
2. **选择数据文件**：`Alt+M` 打开设置 →「数据文件（直接读写）」→ 点「选择已有 JSON 文件」或「新建数据文件」，用系统弹窗选一个 `.json` 文件并允许读写。
3. **开始使用**：在网页上选中英文 → 右键 →「翻译并记录」→ 右侧出现批注栏。之后所有修改会自动写回这个文件。

> 浏览器不允许扩展直接按绝对路径读写文件，所以首次必须用系统文件选择器手动选一次；之后扩展会记住（权限失效时设置页点「重新授权」）。

## 使用

| 操作 | 说明 |
| --- | --- |
| 右键 → 翻译并记录 | 翻译选中文本并生成批注（`Alt+T` 同效） |
| 右键 → 仅记录 | 只记原文，译文稍后手动补 |
| 批注栏 | 右侧边缘「批注 N」标签，或 `Alt+O` |
| 🧠 我译 + AI 审查 | 批注卡片里的按钮：输入自己的翻译，AI 点评并生成学习条目 |
| 🔊 美音 | 批注卡片 / AI 词条 / 复习卡片上的按钮，按美式发音朗读 |
| 内置 PDF 阅读器 | 打开 PDF 后点扩展图标 →「用内置 PDF 阅读器打开」 |
| 📚 常驻气泡 | 右下角，点开 → 复习 / 批注栏 / 设置 |
| 设置 / 全部记录 | `Alt+M`，或扩展详情 → 扩展选项 |
| `Esc` | 关闭批注栏 / 弹窗 |

**嵌套批注**：在一段已有波浪线的文字里再选一个短语右键记录，会自动作为子批注（不同颜色的波浪线、批注栏里缩进）。删除父批注会级联删除子批注。

> **隐私与同步边界**：批注数据直接写入你自己选择的本地 JSON 文件；扩展不会上传它。共用 LLM 配置的 API Key、AI 审查记录、学习条目只保存在本机 `chrome.storage.local`。

## 数据与同步

### 数据文件（File System Access）

- 扩展通过系统文件选择器拿到文件句柄，之后直接读写这个 JSON 文件；句柄保存在扩展 origin 的 IndexedDB。
- **拿不到完整绝对路径**（浏览器安全限制），所以设置页不显示路径，只显示文件名、大小、最后修改时间。
- 首次授权后一般会保持；浏览器重启或权限过期时，设置页会显示「需要重新授权」，点一下即可。
- 可以把文件放在 OneDrive、坚果云、iCloud 等同步目录里，用网盘自己同步；扩展不负责 git/云端提交。
- 仅支持 Edge / Chrome（Chromium）；Firefox 没有 File System Access API。
- 启动时扩展会读文件并与浏览器本地缓存按 `updatedAt` 合并；页面打开时每 6 秒检查一次文件是否被外部修改。

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

合并规则：按 `id` 比较 `updatedAt`，较新者胜出；新增项追加；旧版本计入 `skipped`；父批注悬空/跨页/成环会被自动修复。

> 仓库里的 `sync-server/` 是旧方案（本地 HTTP + git commit/push），当前扩展默认不再使用，只在需要旧流程时保留作参考；不启动它也不影响文件直读写。

## 翻译 Provider

设置页 → 翻译 Provider：

- **MyMemory**（默认）：免费、无需 Key，可能限流。
- **Google Translate 免 Key 接口**：国内网络通常不可用。
- **OpenAI 兼容 / DeepSeek**：填 Base URL / API Key / 模型；DeepSeek 填 `https://api.deepseek.com` + `deepseek-chat`。这份配置同时用于翻译和批注卡片的 AI 审查，只需配一次。
- **自定义 HTTP 接口**：GET 用 `{{text}}`、`{{lang}}` 占位；POST 用 body 模板 + 结果字段路径（如 `data.translation`）；可加自定义 headers。
- **关闭**：只记录原文，译文手动补。

翻译失败不会丢记录：先保存原文并在页面提示，之后在批注栏点 ✎ 补译文。

## 开发与测试

```powershell
node --test tests/          # 全部单元/集成测试
node tests/serve.mjs        # 打印 PORT，供浏览器打开 tests/*.html 冒烟页
```

测试构成：

- `tests/core.test.mjs`：数据模型、页面 URL 规范化、嵌套父批注校验、合并导入、AI 返回解析、翻译分段（17 条）。
- `tests/file-mode.test.mjs`：用假 FileStore 验证文件模式（启动读文件合并、修改写回、外部修改拉取、断开文件）。
- `tests/sync-server.test.mjs`：旧 HTTP 同步服务的契约、合并、git commit/push（10 条，保留作回归）。
- `tests/background.test.mjs`：用 Node VM 模拟 chrome API，验证旧 HTTP 同步链路。
- `tests/render-smoke.html`：浏览器里验证嵌套波浪线、颜色、跨标签节点匹配、选区父级识别。
- `tests/content-smoke.html`：用 chrome API 桩加载真实 `content.js`，验证 UI 注入、批注栏、卡片缩进、toast、选区采集。
- `tests/comment-scroll-smoke.html`：验证批注卡片随页面滚动精确位移（滚动 60px → 卡片 top 同步 -60px）。
- `tests/bubble-review-smoke.html`：验证常驻气泡、气泡菜单、复习筛选/翻面/标记、卡片 AI 审查流程。

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
  filestore.js       File System Access：文件句柄持久化、读写、权限查询
  background.js      后台：右键菜单、翻译 Provider、存储、文件读写、消息路由
  content.js         页面内 UI：批注栏、气泡、复习、toast、快捷键、SPA 监听
  pdfviewer.html/js  内置 PDF 阅读器：pdf.js 渲染 canvas + 文字层
  vendor/pdf.min.js  pdf.js 运行时（离线内置，含 worker）
  options.html/js    设置与批注管理页（选择数据文件、翻译/LLM、分组、全部批注）
sync-server/         旧方案（本地 HTTP + git commit/push），默认不再使用，仅保留作参考
tests/               单元测试、文件模式测试、旧服务集成测试、浏览器冒烟页
legacy-userscript/   旧版油猴脚本（v0.1，已归档）
```

> 学习数据文件不在这个公开仓库里；它由你在设置页用系统文件选择器指定，可以放在任意位置（包括网盘同步目录）。

## 已知限制

- **波浪线依赖文本锚点**：页面文案改版、无限滚动/重渲染、跨 iframe 或 Shadow DOM 的内容可能无法恢复；刷新页面会重新尝试。`pre/code`、输入框、可编辑区域不标注。
- **批注只在本页显示**：同一网站的其他页面不会出现（按 URL 规范化后精确匹配）。
- **嵌套颜色循环**：最多 6 层颜色循环、20 层上限。
- **翻译依赖第三方接口**：可能限流/超时；国内访问 Google 接口通常失败，建议用 MyMemory 或自备 OpenAI 兼容 / DeepSeek / 自定义接口。
- **PDF**：Edge/Chrome 内置 PDF 阅读器无法注入脚本，所以要在 PDF 上批注时，用扩展弹窗的「用内置 PDF 阅读器打开」。它是 pdf.js 渲染的普通页面，选中文字后点右下角 📚 →「记录选中」即可（也可直接打开批注栏）。扫描版 PDF 没有文字层，不能选中/批注；大 PDF 首次渲染会慢一些。
- **数据文件需要授权**：浏览器不允许扩展按绝对路径直接读写，首次必须用系统文件选择器选一次；浏览器重启/权限过期后需要点「重新授权」。
- **没有云端提交**：数据只写本地文件；要跨设备同步就自己把文件放进 OneDrive/坚果云等同步目录。多设备同时改同一批注时按 `updatedAt` 取新，可能覆盖旧内容。
- **数据规模**：`chrome.storage.local` 和全文 JSON 文件适合万条以内批注，不适合超大词库。
- **权限**：扩展声明 `<all_urls>` 以在网页注入批注 UI；数据只写你选择的本地文件，翻译/AI 请求才会联网，无遥测。

## 旧版

- `legacy-userscript/`：v0.1 油猴版本（按网站分组的笔记 + 手动导出 JSON）。
- `sync-server/`：v0.5 之前的本地 HTTP + git 自动 commit/push 方案；当前扩展默认走文件直读写，不再需要启动它。
