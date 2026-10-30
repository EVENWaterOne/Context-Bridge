# 本机后端（Codex / Claude Code）

## 启动与连接

1. 安装 Node.js 24.14 或更高的 Node 24 版本。在项目目录运行 `npm ci`。
2. 开发使用 `npm run dev`，打开 http://localhost:5173 。完整本机版使用 `npm run build`、`npm start`，打开 http://localhost:4173 。Windows 可双击 `start-local.cmd`。
3. 点击顶部横条的连接链接，打开 **AI provider** 设置，选择 **Connect Codex**（默认）或 **Connect Claude Code**。诊断、Review、Apply、Undo 流程两者完全相同。
4. Codex：点击 **Sign in with ChatGPT**，打开页面提供的登录链接，用自己的账号完成正常登录。页面会自动刷新连接状态，也可以手动点击 Refresh status。
5. 模型下拉列表来自当前连接；空选项使用该 provider 的默认模型。Codex 与 Claude Code 各自记住自己的模型选择。账号必须有对应模型使用权限，推理需要联网。

`npm run doctor` 不执行推理：Codex 检查版本、隔离配置、登录状态与模型目录；Claude Code 报告版本、认证方式与模型列表（工具和权限配置在每次实际请求开始时检查）。官方 Codex CLI 版本固定为 0.164.0；升级时必须同时检查协议适配和测试，不能只换二进制。Codex 不依赖桌面 App 内部文件、不复制既有 token，也不要求把 API Key 粘贴到网页。

默认数据位于项目 `.data/`：`bridge.sqlite` 保存任务、操作记录和 provider 选择，`codex/` 是独立 Codex home，`claude/` 保存 Claude Code 的 API key（`auth.json`）与独立配置目录，`runs/` 是送给模型的已选上下文快照。该目录已被 Git 忽略，包含原始文件、备份及凭证，应留在自己的电脑上。可用进程环境 `BRIDGE_DATA_DIR` 指定其他绝对路径。`BRIDGE_PORT` 可改变正式服务端口；开发代理默认仍使用 4173。

## 连接 Claude Code

- **官方方式是 Anthropic API key。** 在 [Claude Console](https://console.anthropic.com/settings/keys) 创建 API key，在 Connect Claude Code 里粘贴并 Save key；或者启动服务前设置 `ANTHROPIC_API_KEY`。页面保存的 key 优先于环境变量。key 只发送到本机服务，以原子写入保存在 `.data/claude/auth.json`（macOS、Linux 上为 0600 仅所有者可读；Windows 上沿用数据目录的权限，请把数据目录放在自己的用户目录下），之后只显示 `sk-ant-…abcd` 这样的尾号提示，不会再返回页面。费用计入该 key。
- 订阅 token（`sk-ant-oat…`）和 Admin key 不能作为 API key 保存，页面会直接说明原因。保存时不调用模型；第一次请求时才确认 key 是否有效。key 被拒绝或账户计费有问题时，请求会在几秒内失败，不会像 Claude Code 默认那样重试几分钟（停止前 Claude Code 可能已再试一两次，Windows 上稍慢）。
- Claude Code 来自 npm 固定版本的 `@anthropic-ai/claude-agent-sdk`（0.3.312，内含对应的 Claude Code 2.1.312），`npm ci` 即可安装，不依赖全局 `claude` 命令。版本不符时服务拒绝启动该 provider；升级时必须同时检查适配器和测试。
- 每次请求都禁用全部内置工具、MCP、插件、设置文件、会话保存和 `@文件` 展开，使用自己的系统提示。需要结构化结果时只提供 StructuredOutput 一个工具。适配器检查 Claude Code 报告的工具列表和权限模式，出现其他工具调用就中止。继承来的 `ANTHROPIC_*`、`CLAUDE_*` 环境变量会被移除，只保留几个连接设置（`CLAUDE_CODE_GIT_BASH_PATH`、客户端证书 `CLAUDE_CODE_CLIENT_*`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）；API key 模式另用独立的 `CLAUDE_CONFIG_DIR`，不读取本机已有的 Claude Code 配置，本机登录模式沿用已设置的 `CLAUDE_CONFIG_DIR`。
- Claude Code 会在每次请求里附带一段简短的环境说明（工作目录、平台、shell、系统版本和日期），自定义系统提示无法去掉。适配器让它在一个空的临时目录里运行（Claude Code 自己的临时文件也放在这里，关闭服务时删除；被系统清理后会自动重建），工程路径和数据目录路径不会出现在这段说明里。
- 模型拒答时，页面显示 Claude Code 给出的原因。适配器关闭了 Claude Code 的拒答重试和备用模型，所选内容只发送一次，也不会改由用户没选的旧模型回答；`auth.json` 损坏时，状态会提示重新粘贴 key，也可以 Remove saved key 重置。
- 取消会中止 Claude Code 子进程；单次请求最长十分钟由适配器兜底，任务层面仍是五分钟。同一时间只运行一个请求。
- `BRIDGE_PROVIDER=claude` 让 Claude Code 成为默认 provider；用户在页面选择后，以数据库里保存的选择为准。有任务运行时不能切换。诊断和聊天请求带上页面当前显示的 provider；如果另一个窗口已经切换，服务返回 409 `PROVIDER_CHANGED` 并刷新连接状态，不会把内容和旧模型发给另一个 provider。

### 本机 Claude Code 登录（仅限个人使用）

启动服务时设置 `BRIDGE_CLAUDE_LOCAL_LOGIN=1`，Connect Claude Code 里会出现 **Personal use only** 区域，可改用这台电脑上 `claude` 命令已经登录的账号。此时服务不会发送 API key，而是沿用本机 Claude Code 的登录（如设置了 `CLAUDE_CONFIG_DIR` 也会沿用）。没有登录时页面提示先在终端运行 `claude` 登录。

这只适合自己在自己电脑上使用。Anthropic 不允许面向他人提供的产品使用 Claude 订阅登录，因此默认关闭；未设置该变量时接口返回 403。共享、部署或给别人用时一律使用 API key。

## 文件与调试流程

- **导入副本**：网页导入的代码、配置、日志、说明保存为任务副本；Apply 后下载或导出即可带走，不会改上传来源文件。
- **绑定工程**：打开 Files → Link local project，输入本机绝对目录，扫描并勾选具体文件，确认绑定。页面标出真实根目录；确认 Apply 会写回这些真实文件。
- 勾选文件才会进入上下文。默认跳过凭证名称、依赖、构建目录、二进制、链接、超过 1 MB 或非 UTF-8 文件。可选文件总量最多 200 个、上下文最多 6 MB；总工作区最多 12 MB。
- 文件按相对路径区分，同名的 `src/config.py` 和 `tests/config.py` 可以同时使用。目录穿越、盘符注入、junction/符号链接越界会被拒绝。
- 完成硬件信息、记录观察，然后发送诊断。结果可能是多文件修改提案，也可能要求补充资料。打开差异逐项审阅；只有点击确认 Apply 才会修改。
- Apply 会检查所有选中的工程上下文及目标文件版本，保留 UTF-8 BOM/CRLF，存原始字节备份，再替换文件。外部文件已修改时先 Refresh from disk，再重新诊断。
- Undo 检查文件仍处于刚应用后的版本；后续手动编辑、任务重新绑定工程都会阻止不安全撤销。已完成轮次不能重新 Apply。新轮次需新诊断。
- Ask BIT 按任务保存会话。聊天只解释、不写文件；需要修改时走诊断和 Review。关闭“使用历史”会排除先前轮次和聊天上下文，使用新的 Codex thread 或 Claude Code 会话，避免旧内容暗中进入请求。

机械臂动画只展示流程，不执行修改后的代码。第一版没有 shell、编译、烧录、串口控制或物理测试；反馈由使用者根据实际观察填写，界面不会把动画播放当作验证通过。

## 旧数据、取消与恢复

- 线上 Vercel 与 localhost 属于不同网站，浏览器不能跨域直接读取旧 localStorage。在原页面 Export task，在本机工作台账户菜单选择 Import task JSON。
- 同一 localhost 来源曾保存的旧浏览器工作区，可以通过 Import old browser workspace 一次导入。导入有来源标识，重复导入同一来源不会再建副本；旧历史不会触发文件写入。
- SQLite 是本机版唯一持久化来源。多个浏览器同时修改时使用 revision 检查；发生冲突会加载服务端版本，并保留可下载的未保存草稿，避免静默覆盖。
- 页面刷新会重新连接仍在运行的任务。Stop/Cancel 会中断实际的 Codex turn 或 Claude Code 子进程；Codex 不回应时有结束子进程的限时兜底。单次服务端请求默认最多五分钟，同一时间只接受一个模型任务。
- 服务重启会将未完成任务标成 interrupted，允许重新提交。多文件写入使用持久化操作日志；启动时回滚中断操作，不把 SQLite 事务误当成多文件原子事务。
- 如果恢复过程中发现外部编辑，自动恢复会停下，保留备份并通过 `/api/status` 的 `recovery` 返回需要处理的操作。不要删除 `.data/`；先备份整个数据目录与工程，再处理外部编辑。恢复目标匹配后重启服务即可重试恢复。

## API 约定

所有 API 同源且只用于本机。先 `GET /api/workspace` 建立 HttpOnly、SameSite=Strict 会话。修改请求必须带正确 Origin 和 Cookie。Host 只接受 localhost/127.0.0.1；编码路径别名及跨来源访问会被拒绝。后端不提供任意 Codex RPC 或 Claude Code 工具转发。

| 接口 | 输入或结果 |
| --- | --- |
| `GET /api/workspace` | `{version:2,revision,workspace,activeJobs}`；内部 workspace 保持兼容的 version 1 |
| `PUT /api/workspace` | `{workspace,expectedRevision}`；返回权威版本，409 表示冲突 |
| `POST /api/workspace/import` | `{task?,workspace?,sourceId}`；只导入历史和副本，不继承真实工程绑定 |
| `GET /api/status` | `{mode,version,provider,providers,agent,recovery}`：当前 provider、可选 provider、当前 provider 的版本/账号/模型（Claude Code 另有 `agent.claude` 认证方式和 key 尾号）及恢复提醒。旧字段 `codex` 已改名为 `agent` |
| `POST /api/agent/provider` | `{provider:'codex'|'claude'}` → 新状态；保存选择，有任务运行时 409 |
| `POST /api/codex/login` | Codex 管理的登录链接，凭证不返回页面 |
| `PUT /api/claude/api-key` | `{apiKey}` → 新状态；只保存，不调用模型，不回显 key |
| `DELETE /api/claude/api-key` | 删除页面保存的 key → 新状态（环境变量中的 key 仍可用） |
| `PUT /api/claude/auth-method` | `{method:'api_key'|'local_login'}` → 新状态；未开启 `BRIDGE_CLAUDE_LOCAL_LOGIN=1` 时选 local_login 返回 403 |
| `POST /api/tasks/:id/project/scan` | `{path}` → 根目录 ID、文件清单、跳过原因 |
| `POST /api/tasks/:id/project/bind` | `{rootId,paths}` → 权威工作区 |
| `POST /api/tasks/:id/project/refresh` | 从已绑定的实际文件更新快照 |
| `POST /api/agent/investigate` | `{taskId,roundId,model?,provider?}` → 202 job；`provider` 与当前不符时 409 `PROVIDER_CHANGED`，省略时按 `codex`（旧页面只认识 Codex） |
| `POST /api/agent/chat` | `{taskId,message,model?,provider?}` → 202 job；同上 |
| `GET /api/tasks/:id/messages` | 当前任务持久化聊天 |
| `GET /api/jobs/:id` | 已持久化的任务状态 |
| `GET /api/jobs/:id/events` | SSE：`event: job`，data 为完整 job；终态后关闭 |
| `POST /api/jobs/:id/cancel` | 中断真实任务；最终状态以 job 终态为准 |
| `POST /api/agent/apply` | `{taskId,roundId,suggestionId,idempotencyKey}` → 操作 ID、变更文件、权威工作区 |
| `POST /api/operations/:id/undo` | `{idempotencyKey}` → 撤销结果和权威工作区 |

错误统一为 `{error:{code,message}}`。诊断结果区分 `proposal` 和 `needs_information`；提案中 `changes[]` 的前置哈希和原文由后端生成，模型只能给选定现有路径的完整修改后文本。Apply 不接受客户端传入的任意补丁，也不会再次调用模型生成。

## 验证

```sh
npm test
npm run build
npm run doctor
```

自动测试使用隔离临时目录和 FakeProvider，覆盖 API、真实文件替换、冲突、取消、崩溃恢复、Codex 子进程协议和 Claude Code 适配器（模拟 SDK）。`tests/claude-binary.test.ts` 用本机模拟的 Messages API 运行真实 Claude Code 二进制，确认无工具、`@文件` 不展开、数据目录路径不出现在请求里、只发出一次请求、拒答不重试也不换模型、key 被拒几秒内失败、取消会结束进程；其他连接都被本机代理拒绝，不使用任何 Anthropic 账号或网络。Windows 管理沙箱可能禁止覆盖式 rename/junction；应在正常本机权限下运行文件测试，不能因此降级原子写入保护。真实调用验收需先完成正常 Codex 登录或配置 Anthropic API key，应单独记录，不能把 FakeProvider 或模拟 API 通过描述为真实模型成功。

Vercel 继续部署 `dist/` 展示版。本机服务只监听 127.0.0.1；不要将它作为公网多用户后台，也不要通过隧道公开。公网账户、数据隔离和独立执行环境属于后续版本。
