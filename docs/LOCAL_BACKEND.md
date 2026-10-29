# 本机 Codex 后端

## 启动与连接

1. 安装 Node.js 24.14 或更高的 Node 24 版本。在项目目录运行 `npm ci`。
2. 开发使用 `npm run dev`，打开 http://localhost:5173 。完整本机版使用 `npm run build`、`npm start`，打开 http://localhost:4173 。Windows 可双击 `start-local.cmd`。
3. 点击 **Connect Codex → Sign in with ChatGPT**，打开页面提供的登录链接，用自己的账号完成正常登录。页面会自动刷新连接状态，也可以手动点击 Refresh status。
4. 模型下拉列表来自当前账号；空选项使用 Codex 默认模型。账号必须有对应模型/Codex 使用权限，推理需要联网。

`npm run doctor` 只检查真实 CLI 的版本、隔离配置、登录状态与模型目录，不执行推理。官方 CLI 版本固定为 0.164.0；升级时必须同时检查协议适配和测试，不能只换二进制。应用不依赖桌面 App 内部文件、不复制既有 token，也不要求把 API Key 粘贴到网页。

默认数据位于项目 `.data/`：`bridge.sqlite` 保存任务和操作记录，`codex/` 是独立 Codex home，`runs/` 是送给模型的已选上下文快照。该目录已被 Git 忽略，包含原始文件、备份及凭证，应留在自己的电脑上。可用进程环境 `BRIDGE_DATA_DIR` 指定其他绝对路径。`BRIDGE_PORT` 可改变正式服务端口；开发代理默认仍使用 4173。

## 文件与调试流程

- **导入副本**：网页导入的代码、配置、日志、说明保存为任务副本；Apply 后下载或导出即可带走，不会改上传来源文件。
- **绑定工程**：打开 Files → Link local project，输入本机绝对目录，扫描并勾选具体文件，确认绑定。页面标出真实根目录；确认 Apply 会写回这些真实文件。
- 勾选文件才会进入上下文。默认跳过凭证名称、依赖、构建目录、二进制、链接、超过 1 MB 或非 UTF-8 文件。可选文件总量最多 200 个、上下文最多 6 MB；总工作区最多 12 MB。
- 文件按相对路径区分，同名的 `src/config.py` 和 `tests/config.py` 可以同时使用。目录穿越、盘符注入、junction/符号链接越界会被拒绝。
- 完成硬件信息、记录观察，然后发送诊断。结果可能是多文件修改提案，也可能要求补充资料。打开差异逐项审阅；只有点击确认 Apply 才会修改。
- Apply 会检查所有选中的工程上下文及目标文件版本，保留 UTF-8 BOM/CRLF，存原始字节备份，再替换文件。外部文件已修改时先 Refresh from disk，再重新诊断。
- Undo 检查文件仍处于刚应用后的版本；后续手动编辑、任务重新绑定工程都会阻止不安全撤销。已完成轮次不能重新 Apply。新轮次需新诊断。
- Ask BIT 按任务保存会话。聊天只解释、不写文件；需要修改时走诊断和 Review。关闭“使用历史”会排除先前轮次和聊天上下文，使用新 Codex thread，避免旧内容暗中进入请求。

机械臂动画只展示流程，不执行修改后的代码。第一版没有 shell、编译、烧录、串口控制或物理测试；反馈由使用者根据实际观察填写，界面不会把动画播放当作验证通过。

## 旧数据、取消与恢复

- 线上 Vercel 与 localhost 属于不同网站，浏览器不能跨域直接读取旧 localStorage。在原页面 Export task，在本机工作台账户菜单选择 Import task JSON。
- 同一 localhost 来源曾保存的旧浏览器工作区，可以通过 Import old browser workspace 一次导入。导入有来源标识，重复导入同一来源不会再建副本；旧历史不会触发文件写入。
- SQLite 是本机版唯一持久化来源。多个浏览器同时修改时使用 revision 检查；发生冲突会加载服务端版本，并保留可下载的未保存草稿，避免静默覆盖。
- 页面刷新会重新连接仍在运行的任务。Stop/Cancel 会调用实际 turn 中断；Codex 不回应时有结束子进程的限时兜底。单次服务端请求默认最多五分钟，同一时间只接受一个 Codex 任务。
- 服务重启会将未完成任务标成 interrupted，允许重新提交。多文件写入使用持久化操作日志；启动时回滚中断操作，不把 SQLite 事务误当成多文件原子事务。
- 如果恢复过程中发现外部编辑，自动恢复会停下，保留备份并通过 `/api/status` 的 `recovery` 返回需要处理的操作。不要删除 `.data/`；先备份整个数据目录与工程，再处理外部编辑。恢复目标匹配后重启服务即可重试恢复。

## API 约定

所有 API 同源且只用于本机。先 `GET /api/workspace` 建立 HttpOnly、SameSite=Strict 会话。修改请求必须带正确 Origin 和 Cookie。Host 只接受 localhost/127.0.0.1；编码路径别名及跨来源访问会被拒绝。后端不提供任意 Codex RPC 转发。

| 接口 | 输入或结果 |
| --- | --- |
| `GET /api/workspace` | `{version:2,revision,workspace,activeJobs}`；内部 workspace 保持兼容的 version 1 |
| `PUT /api/workspace` | `{workspace,expectedRevision}`；返回权威版本，409 表示冲突 |
| `POST /api/workspace/import` | `{task?,workspace?,sourceId}`；只导入历史和副本，不继承真实工程绑定 |
| `GET /api/status` | 服务、Codex 版本/账号/模型及恢复提醒 |
| `POST /api/codex/login` | Codex 管理的登录链接，凭证不返回页面 |
| `POST /api/tasks/:id/project/scan` | `{path}` → 根目录 ID、文件清单、跳过原因 |
| `POST /api/tasks/:id/project/bind` | `{rootId,paths}` → 权威工作区 |
| `POST /api/tasks/:id/project/refresh` | 从已绑定的实际文件更新快照 |
| `POST /api/agent/investigate` | `{taskId,roundId,model?}` → 202 job |
| `POST /api/agent/chat` | `{taskId,message,model?}` → 202 job |
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

自动测试使用隔离临时目录和 FakeProvider，覆盖 API、真实文件替换、冲突、取消、崩溃恢复和 Codex 子进程协议。Windows 管理沙箱可能禁止覆盖式 rename/junction；应在正常本机权限下运行文件测试，不能因此降级原子写入保护。真实调用验收需先完成正常 Codex 登录，应单独记录，不能把 FakeProvider 通过描述为真实模型成功。

Vercel 继续部署 `dist/` 展示版。本机服务只监听 127.0.0.1；不要将它作为公网多用户后台，也不要通过隧道公开。公网账户、数据隔离和独立执行环境属于后续版本。
