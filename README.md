# AI Skill Manager

管理本地 **Agent Skills** 的桌面应用。支持 Claude Code、Codex、Cursor、Gemini CLI、Copilot 等 8 种 AI 编码工具的技能目录。

Electron + 原生前端，Windows 优先（macOS / Linux 的目录联接已做兼容，但未充分测试）。

---

## 它能做什么

### 技能管理
- 扫描 `~/.claude/skills` 与 `~/.claude/skills-disabled`，列出全部技能
- **目录监听**：外部安装 / 删除技能后自动刷新
- 解析 `SKILL.md` 的 YAML 头，检测语法错误、缺 description、name 不一致、重名
- 自动分类（视频生成 / 图像生成 / 渲染 / UI / 短剧 / 分镜 / 工具）
- 搜索（中英文都匹配）、按分类筛选、只看有问题的、显示 / 隐藏已禁用
- **启用 / 禁用**：在两个目录间移动，不删除
- **内置编辑器**：直接改 SKILL.md，保存后立即校验 YAML
- **卸载（两步确认）**：第一步说明后果，第二步要求手打技能名才解锁「永久删除」

### 项目级
- 侧边栏「作用域」可添加任意项目目录，切换后管理该项目自己的 `.claude/skills`
- 项目内的启用 / 禁用独立于全局，互不影响

### 更新
- **检查更新**：区分「可追踪」与「本地技能」
- **更新前自动备份**：批量更新前自动快照，可回滚
- **差异预览**：对比本地与远端 SKILL.md，逐行显示新增 / 删除
- **批量更新**

### 健康
- **一键修复**：自动修 YAML 转义、补 description、修正 name
- **依赖体检**：检查 Node / npm / git / belt / runcomfy / hyperframes
- **按技能标注依赖**：只有真正需要某个 CLI 的技能才会显示「缺 xxx」

### 备份
- 手动备份 / 更新前自动备份
- 列表查看、一键还原（还原前会再备份当前状态）

### 套装
- 内置四套：短剧生产包 / 图像出图包 / 视频渲染包 / 前端设计包
- 「启用该套装」或「只留该套装」（禁用其余），随时可逆
- 已启用 / 部分启用 / 未启用 状态实时显示

### 分发
- 把技能共享给其他 AI 工具，用 Windows 目录联接（junction），不占空间、改一处即生效
- 自动探测已装工具；断开只移除本程序创建的链接
- **导出技能包**：给豆包这类没有技能目录的工具，生成精简版或完整版 Markdown

### 自动归位（只报告）
- 扫描各 AI 工具的技能目录，找出散落在别处的技能
- 与唯一目录比对指纹，分为「新增 / 重复（内容相同）/ 冲突（内容不同）」
- **当前只报告，不移动任何文件**

### 市场
- 直接搜索 skills.sh，显示安装量，一键安装到全局
- **来源标记**：`superpowers 衍生`（镜像）/ `RunComfy 系`（另一套实现）
- **来源详情**：仓库 Stars、最近更新、是否 fork、文件路径、需要的 CLI、**内容指纹**

### 其他
- 深色 / 浅色双主题
- 中英文介绍切换
- 操作日志
- 托盘常驻（关闭行为可在设置里切换）
- 定时检查更新
- 单实例锁定

---

## 运行要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22.20** | 检查更新、市场、安装功能需要它；没有也能打开程序，但相关按钮会禁用 |
| Windows | 10 / 11 | 目录联接需要 NTFS |
| npm | 任意 | 随 Node 附带 |

> **安装包不包含 Node 运行时。** 目标机器需要自行安装 Node.js 22+，否则「检查更新 / 市场 / 安装」不可用，其余功能（浏览、启用禁用、编辑、备份、分发、归位扫描）不受影响。

---

## 开发

```bash
git clone <your-repo-url>
cd skills-manager
npm install
npm start
```

打开控制台：

```bash
npm run dev
```

## 打包

生成 Windows 安装程序（NSIS，按用户安装、不需要管理员权限）：

```bash
npm run build
```

产物在 `dist/AI Skill Manager-1.0.0-setup.exe`。

只生成解包目录（调试用，启动快）：

```bash
npm run build:dir
```

---

## 数据位置

程序自身的数据（不在技能目录里）：

```
%APPDATA%\skills-manager\
├── settings.json      设置、套装定义、已添加的项目列表
├── operations.log     操作日志
└── backups\           备份快照
```

技能目录（由 `skills` CLI 决定）：

```
~/.claude/skills/            全局启用的技能
~/.claude/skills-disabled/   被本程序禁用的技能
<项目>/.claude/skills/        项目级技能
```

---

## 调试模式

```bash
npx electron . --shot              # 截图到 shot-*.png 后退出
npx electron . --selftest          # 后端全功能自测
npx electron . --test-dist         # 分发链路自测（建链接→读穿→断开）
npx electron . --test-preset       # 套装应用自测
npx electron . --test-uninstall    # 卸载自测（临时技能，用完即删）
npx electron . --test-market       # 市场来源详情自测
npx electron . --test-reconcile    # 归位扫描自测
npx electron . --test-project      # 项目级自测
```

自测都不会碰你的真实技能（`--test-uninstall` / `--test-project` 用临时目录）。

---

## 已知限制

- **豆包网页版 / 网页版 AI**：没有本地技能目录，管不到
- **豆包桌面版**：只有 Chromium 扩展机制，不是 Agent Skill 规范目录
- 自动归位目前**只报告不搬运**，等规则验证稳定后再开自动模式
- 未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选「仍要运行」即可

---

## 许可

MIT
