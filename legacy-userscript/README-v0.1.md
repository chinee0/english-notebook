# English Notebook · 英语句子与词组笔记

油猴（Tampermonkey）脚本：在任意网页选中不会的英文句子或词组，按 `Alt+S` 记下来；记录按「分组」管理，分组可以绑定网址；全站静默，只靠快捷键和油猴菜单唤出；数据存在油猴本地存储，导出 JSON 后放进本仓库的 `data/english-notes.json`，由 git 做版本管理。

## 功能（v0.1）

- **选中即记**：选中英文后 `Alt+S`。若当前网站恰好只关联一个分组，直接保存并提示；否则弹出快速记录卡（可补释义、选/新建分组）。
- **按网站看笔记**：`Alt+O` 打开侧栏，只列与当前网址相关的分组和记录，支持搜索。
- **管理器**：`Alt+M` 左侧分组树（全部 / 各分组 / 未分组），右侧条目，支持全局搜索、编辑、删除、复制、朗读、打开来源。
- **分组可绑定域名**：`bbc.com` 会匹配 `www.bbc.com`、`news.bbc.com` 等子域；留空则为通用分组。记录可以随时移到任意分组，不受来源网址限制。
- **重访高亮**：再次打开记录过的网站，已记录的句子会自动标黄，悬停显示释义，点击跳回侧栏对应条目。
- **朗读**：使用浏览器内置 `speechSynthesis`（英文语音，免费离线）。
- **导出 / 导入 JSON**：合并（同 id 保留较新版本）或覆盖，方便与 git 仓库同步。
- **不打扰**：没有悬浮按钮和常驻面板；适配 SPA 站点导航与深色模式。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+S` | 记录当前选中内容 |
| `Alt+O` | 打开当前网站侧栏 |
| `Alt+M` | 打开管理器 |
| `Esc` | 关闭最上层面板 |

油猴菜单里也有同样的入口（记录、侧栏、管理器、导出、导入、切换重访高亮）。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. Tampermonkey → 新建脚本，把 `english-notebook.user.js` 的全部内容粘贴进去并保存（或：实用工具 → 从文件导入）。
3. 打开任意英文网页，选中一句话按 `Alt+S` 试试。

## 分组与「网址绑定」的逻辑

- 分组**手动创建**，可填一个或多个绑定域名（空格或逗号分隔），可用带 `www.` 的写法，会统一规范化；子域自动匹配。
- 在绑定网站按 `Alt+S`：
  - 恰好一个分组匹配当前网站 → 直接记入，toast 提示「已记入某分组」，可撤销；
  - 没有分组或匹配到多个 → 弹出记录卡，默认用当前域名新建分组（如 `bbc.com`），也可以选「未分组」或已有分组。
- 侧栏默认只显示「绑定当前网站」或「有当前网站来源记录」的分组；勾选「全部组」可看全部。
- 记录可在侧栏/管理器里移到任意分组，这是「条目自由归属」。

## 数据与 git 仓库

浏览器里的油猴脚本不能直接读写本地文件，所以数据流是「本地存储 + 手动导出/导入」：

1. 管理器 → `导出 JSON`，浏览器下载 `english-notes-YYYYMMDD-HHmmss.json`；
2. 用它覆盖本仓库的 `data/english-notes.json`；
3. `git add data/english-notes.json && git commit -m "notes: 更新"`，需要跨设备再 push。

换设备 / 恢复数据：`git pull` → 管理器 → `导入 JSON` → 选「合并」（推荐）或「覆盖」。

`data/english-notes.json` 结构：

```json
{
  "version": 1,
  "exportedAt": "2026-10-18T15:00:00.000Z",
  "groups": [
    { "id": "g_xxx", "name": "BBC 新闻", "hosts": ["bbc.com"], "createdAt": "...", "updatedAt": "..." }
  ],
  "items": [
    {
      "id": "i_xxx",
      "groupId": "g_xxx",
      "text": "The committee has yet to reach a decision.",
      "note": "委员会尚未作出决定",
      "sourceUrl": "https://www.bbc.com/news/...",
      "sourceTitle": "BBC News",
      "sourceHost": "bbc.com",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

## 开发

```powershell
node build.mjs       # 合成 english-notebook.user.js（header + core + ui）
node --test tests/   # core 单元测试（13 条）
```

UI 冒烟测试（需要 Chromium 内核浏览器，如 Edge）：

```powershell
# 终端 1：起本地静态服务，会打印 PORT
node tests/smoke-server.mjs

# 终端 2：无头浏览器访问（把 PORT 换成实际端口）
msedge --headless=new --disable-gpu --no-sandbox --user-data-dir=%TEMP%\enb-profile `
  --virtual-time-budget=9000 --dump-dom http://127.0.0.1:PORT/tests/ui-smoke.html
```

两个冒烟页面：

- `tests/ui-smoke.html`：已有数据（预置分组/记录），验证 Alt+S 直存、侧栏、管理器、重访高亮；
- `tests/ui-smoke-empty.html`：全新安装，验证 Alt+S 弹出记录卡、默认新建当前域名分组、保存成功。

页面把结果写入 `<body data-smoke="...">`，形如：

```
host=true;shadow=true;toast=true;savedItems=2;savedTextMatch=true;sidebarOpen=true;groups=1;items=2;managerOpen=true;groupRows=2;managerItems=2;marks=1
```

## 文件结构

```
english-notebook.user.js   # 构建产物，安装用这个
src/header.txt             # 油猴元信息（@match、@grant）
src/core.js                # 纯数据逻辑：分组、记录、导入导出、网址匹配
src/ui.js                  # Shadow DOM UI：快捷键、侧栏、管理器、高亮
data/english-notes.json    # 仓库内的数据文件（导出后覆盖）
tests/core.test.cjs        # 单元测试
tests/ui-smoke.html        # 浏览器冒烟测试页面
tests/smoke-server.mjs     # 冒烟测试用的极简静态服务
```

## 已知限制

- **重访高亮基于文本精确匹配**：如果站点改写了文字、把一句话拆进多个标签，或文本在 iframe 里，就会漏标；默认跳过 `pre/code` 和可编辑区域，最多标记 300 处。
- 只在「记录来源 host 与当前页 host 匹配」时高亮，子域按绑定规则匹配（如 `bbc.com` 覆盖 `news.bbc.com`）。
- 每条记录上限 4000 字符，释义 5000 字符。
- SPA 站点用 1.5 秒轮询 + history 包装来感知 URL 变化，偶尔会有短暂延迟。
- 记录很多（数千条）时高亮扫描变慢，可在管理器里关闭「重访高亮」。
- 纯本地存储，没有自动云同步；跨设备同步依赖「导出 → 提交 git → 另一台 pull → 导入」。

## v2 计划（未实现）

- 间隔重复复习队列（Again / Hard / Good / Easy）与每日复习提醒
- 挖空测试、听写
- 记录标签与更细的筛选
- 可选：接 GitHub API 直接读写仓库文件（需要 token）
