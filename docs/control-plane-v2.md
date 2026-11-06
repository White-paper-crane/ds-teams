# ds-teams 控制面 v2

> 状态：已落地（2026-11-03 21:36）。目标不是把房间做得更热闹，而是把“谁在干活、干到哪、凭什么算完成”从聊天流里拿出来，变成一条可查、可验、可复盘的台账。

## 1. 为什么改

旧架构是“两个中央调度器 + 一条有损聊天总线”：

- 两端各自轮询房间、各自判断相关性、各自决定是否注入；
- 任务卡、报告、复核都可能被 burst/flood/backlog-skip 折叠；
- 双投、claim 冲突、busy hold、僵尸代际都是分布式系统才有的失败模式；
- 真正的 fan-out（T-SPAWN 2.0 min、T-ME-3 1.4 min）很快，长尾全在协调层。

审计窗口内：14 个任务、1,946 条消息、任务卡注入率 3.9%、1,933 条 `fetch failed`、578 次 hold 累计 5,014 秒、token 估算 5–10×。问题不在“多 Agent”，在控制面。

## 2. 目标形态

```
人 / QQ / 桌面
      │ 通知、审批、看板
   Room/UI  ← 只读视图，不是运行时
      │
  Lead（唯一控制面：规划、派活、合并、写账本）
   ├─ worker A（独立 context，只读/独立写面）→ 文件
   ├─ worker B → 文件
   └─ worker C → 文件
      │
  Gate：测试/typecheck/schema/repro → 盲审（fresh context）→ 人审（高风险）
      │
  Ledger（dispatch-state.json）← 唯一任务状态
```

六条硬规矩：

1. **一个写者**：Lead 持笔；worker 只写自己的文件/目录，不碰共享文件；不嵌套团队。
2. **一个账本**：`data/dispatch-state.json` 是任务状态唯一真源；项目空间的 `activeTasks` 只读派生。
3. **一个控制面**：不再有第二个同权监管者；需要第二视角时，只读 observer。
4. **worker 只做真并行**：分片独立、读多写少、每片值得独立上下文；默认 2–3 个，4 个只在真正独立时用。
5. **验证是门，不是团队**：先跑确定性检查（测试、typecheck、schema、复现脚本）；只有高风险/不可逆才上盲审；盲审只看工件 + 验收标准，最多一轮。
6. **房间降级**：保留人类聊天、通知、审批、回看；任务派发与状态只走台账；跨端唤醒用 `proactive_set`，不用 2 秒轮询。

## 3. 台账数据模型

继续使用 `data/dispatch-state.json`，不新建第二份任务账本。旧字段保留，新增：

| 字段 | 含义 |
|---|---|
| `projectId` | 任务所属项目，例如 `proj-ds-teams`；旧房间任务可缺省 |
| `title` | 人类可读标题 |
| `acceptance` | 验收标准数组，必须可判定 |
| `writeScope` | 允许写的文件/目录前缀；`scope` 用 git 工作区审计，空值不认证隔离 |
| `gate` | `{command,cwd,timeoutMs}`；确定性检查命令 |
| `gate.last` | 最近一次 gate 结果：pass/exitCode/durationMs/stdoutHash/stderrHash/tails/evidencePath |
| `artifacts` | `[{path,size,sha256,at}]`；只登记，不复制 |
| `events` | append-only 事件流，最多保留 200 条 |
| `reviews` | `[{by,verdict,note,at}]`；盲审/人审记录 |
| `owner` / `assignee` | 控制面负责人 / 执行 worker |

任务 key 仍为 `projectId::taskId`；旧房间任务为 `roomId::taskId`。

状态沿用 `protocol.mjs`：

```
queued → claimed → running → reported → done
                    ↘ blocked / failed / timeout / interrupted / aborted
```

`reported` 表示“工件已交、gate 已跑”，不等于完成；`done` 必须 gate pass（或人工 `--force` 并写明理由）。

## 4. CLI

```bash
# 建卡（不占并发名额）
node control.mjs create proj-ds-teams T-001 \
  --title "把双桥自动注入关掉" \
  --acceptance "bridge 插件不再注入房间消息" \
  --acceptance "房间仍可人类聊天" \
  --scope "plugins/cordis.patch.yml" \
  --gate "node tests/run-all.mjs" --cwd .

# 开工（占名额；满额返回 queued）
node control.mjs start proj-ds-teams T-001 --assignee worker-a

# 跑 gate（读任务里的 gate.command，写证据到 data/gates/）
node control.mjs gate proj-ds-teams T-001

# 给隔离 worker 的自包含 prompt
node control.mjs brief proj-ds-teams T-001

# 登记工件（校验文件存在，算 sha256）
node control.mjs report proj-ds-teams T-001 \
  --artifact reports/T-001.md --summary "已关闭自动注入"

# 审计 worker 是否越过 writeScope；越界 exit 1
node control.mjs scope proj-ds-teams T-001

# 人审通过（gate 未过会拒绝；--force 需写 --note）
node control.mjs accept proj-ds-teams T-001 --by you --note "看过 diff"

# 驳回
node control.mjs reject proj-ds-teams T-001 --by you --note "gate 没跑"

# 查看
node control.mjs show proj-ds-teams T-001
node control.mjs list --project proj-ds-teams
```

旧的 `dispatch.mjs claim/set/review` 继续可用，供历史房间任务使用；新任务优先走 `control.mjs`。

### 4.1 隔离 subagent

- Lead 建卡时必须写 `writeScope`，再用 `brief` 生成 worker prompt；worker 只拿到任务、验收、写面、gate，不继承 Lead 的会话历史。
- worker 只写 `writeScope` 里的路径；不嵌套派 agent，不直接改 `data/dispatch-state.json`，不靠房间消息回传。
- Lead 在 `report` 前跑 `scope`：用 `git status --porcelain` 对照写面，越界 exit 1；空 `writeScope` 直接拒绝认证。
- `scope-lib.mjs` 只做审计，不改文件；最终合并和共享文件仍由 Lead 持笔。

## 5. Gate

`gate.mjs` 是确定性检查执行器：

- 只认退出码 0 为 pass；超时、信号、非 0 都算 fail；
- 记录命令、cwd、耗时、退出码、stdout/stderr 的 sha256 与尾部 4KB；
- 证据写入 `data/gates/<project>-<task>-<timestamp>.json`；
- 不自动修代码、不重试、不换模型；失败就把尾巴交回 Lead。

这一层替代“再派一个 agent 看看”。只有当 gate 通过、但风险仍高（不可逆、跨权限、对外发送、安全）时，才需要盲审。

## 6. 房间的新角色

房间不再是 Agent 运行时消息总线：

- `chatroom-bridge-v2`、`ds-teams-bridge`、`ds-teams-bridge-me` 三个自动注入插件停用；
- 房间保留：人类聊天、通知、审批、历史回看；
- 任务创建/状态/报告/复核以台账为准，房间消息只是事件副本；
- 跨端叫醒用 `proactive_set`（单跳、带文件产物、限频），不做常驻轮询。

## 7. 控制台

新增 `control.html`，由 `server.mjs` 在 `/control` 提供：

- 顶部：运行中 / 待审 / 阻塞 / 今日完成；
- 左侧：任务列表、项目筛选、状态筛选；
- 右侧：验收标准、gate 结果、artifacts、events、reviews；
- 操作：批准 / 驳回（仅 `reported` + gate pass 可批准）；
- 只读优先；执行仍走 CLI/Lead。

## 8. 迁移顺序

1. 写本文档与 `changes.txt`。
2. 扩展 `dispatch-lib.mjs`，保持旧测试全绿。
3. 新增 `gate.mjs`、`control.mjs`、单测。
4. 服务端加 `/api/control/*` 与 `/control`。
5. 停用三个自动注入插件（live + 仓库快照），写 `改动记录.txt`；插件文件移 `Desktop\trash\2026-11-03\`。
6. 更新 README、协议、项目空间派生。
7. 全量测试 + 端到端演练 + 独立审计。

## 9. 验收

- `node tests/run-all.mjs` 全绿；
- 新建一张任务卡，`start → gate → report → accept` 全链路可复现；
- gate 失败时不能 accept（除非 `--force` 有 note）；
- `/control` 能显示任务、gate、artifacts、events；
- 双桥停用后，房间消息不再触发 agent 自动回合；
- 项目空间 `project_state` 能看到新任务（只读派生）；
- 所有删除都进 `Desktop\trash\2026-11-03\`，`changes.txt` / `改动记录.txt` 有记录。

## 10. 非目标

- 不做自动 spawn 的“自治 agent 团队”；
- 不做第二份任务数据库；
- 不重写房间 UI；
- 不做跨模型审查（当前只有 deepseek-flash，等有第二 provider 再说）。

## 11. 实施结果（2026-11-03）

- 后端：`dispatch-lib.mjs` 扩展、`gate.mjs`、`control.mjs`、`server.mjs` 路由、`projects.mjs` 派生、`control.html` 全部落地。
- 测试：`node tests/run-all.mjs` → `# tests 22 / # pass 22 / # fail 0`；`control.test` 13 条、`gate.test` 5 条、`check.test` 6 条。
- 删除：双桥插件、burst/claim/stall 库及 3 个测试套件移入 `Desktop\trash\2026-11-03\ds-teams-v2-removed\`。
- live：三个桥接 insert 已停用并 reload；8792 重启 pid 31724；`/control`、`/api/control/state` 200。
- 回滚：live 配置 `trash\2026-11-03\ds-teams-v2-removed\cordis.patch.yml.before-v2`；台账 `dispatch-state.before-v2.json`。

## 12. 真实任务演练（T-V2）

用控制面本身跑了一遍迁移任务，而不是只跑临时台账：

- `node control.mjs create proj-ds-teams T-V2 ...` → `start` → `gate` → `report` → `accept`；
- 终态 `done`，gate `pass`，证据 `data/gates/proj-ds-teams-T-V2-2026-11-03T13-42-30-155Z.json`；
- 任务卡带 3 条验收标准、6 个 writeScope、4 个 artifacts、1 条 review；
- `GET /api/control/state` 显示 `counts.all=15 / active=0 / done=11`，T-V2 可见；
- 所有动作事件都写入 `data/dispatch-state.json` 的 `events`，没有另起账本。
