# GapGraph 缺口图谱

备考者的「掌握度可视化 + 每日补习计划」桌面软件。Electron + TypeScript，纯本地运行，断网可用。

> 设计依据：`docs/gapgraph-功能设计报告.md`（技术规格）、`docs/gapgraph-功能说明-通俗版.md`（产品说明）、`docs/graph-radial.html`（可视化定稿）。

## 快速开始

### Windows 浏览器版

1. **首次使用或换电脑**时，双击项目根目录的 `setup.bat`。它检查 Node.js 和网页依赖，缺少 Node.js 时尝试通过 Windows 包管理器安装 LTS。遇到安装协议或权限提示，按安装窗口的说明操作。没有可用的包管理器时，从 [Node.js 官网](https://nodejs.org/en/download) 安装包含 npm 的 Windows LTS 版本（至少 22.12），然后重新双击 `setup.bat`。
2. **API Key** 已通过 `DEEPSEEK_API_KEY` 或 `~/.dsh/.credentials.yaml` 配置时会自动读取。首次缺失时，在 [DeepSeek 平台](https://platform.deepseek.com/api_keys) 创建 Key，再按 `setup.bat` 的提示粘贴。输入会被遮挡，Windows 会为当前账户加密保存在 `.data/windows/deepseek.dpapi`。换账户或电脑后重新配置即可。要替换由启动器保存的 Key，可删除该加密文件后再次运行 `setup.bat`。
3. **日常使用**时，双击 `start.bat`。窗口会先启动 AI 服务，再启动网页并打开默认浏览器。网页通常是 `http://localhost:5180`。端口被占用时，Vite 会选择其他端口，以窗口第 4 步显示的实际地址为准。网页学习数据按浏览器地址保存，端口变化时浏览器会使用另一个站点的存储。
4. **停止服务**时，在启动窗口按 `Ctrl+C` 或关闭窗口。启动失败时，先查看窗口里的具体错误。提示依赖或 Key 缺失时重新运行 `setup.bat`。AI 端口默认是 `3300`，若已被占用，先关闭占用它的服务，再重试。若只提示浏览器无法自动打开，可复制第 4 步的地址。

初始化按 `package-lock.json` 安装依赖，并记录锁文件哈希和 Node.js 版本。依赖状态未变化时跳过安装。安装禁用 npm 生命周期脚本，网页直接使用锁定的 Windows esbuild 二进制包。Electron 的运行时仅在使用 `start-dev.cmd` 时按需安装。两个入口只对本次脚本进程使用 PowerShell 执行策略参数。

**桌面版（Electron）**

```bash
npm.cmd run dev      # 或双击 start-dev.cmd 安装并启动 Electron
```

> 当前这台机器上 Electron 起不来：`electron.exe --version` 不加 `--no-sandbox` 直接退出（0x80000003），
> 加参数后一建窗口就 0xC0000005 崩溃；换 Electron 40 同样崩，而系统 Edge（同为 Chromium 内核）能正常开窗，
> Electron 自带的最小示例也崩 —— 与本项目代码无关，是运行环境问题。
> 比赛现场换机器大概率正常，期间用浏览器版即可完整使用产品。

**其他命令**

```bash
npm.cmd test          # 领域单测
npm.cmd run typecheck # 主进程 + 渲染进程类型检查
npm.cmd run build     # 产出 Electron 三端 out/
npm.cmd run build:web # 产出浏览器版 out/web/
```

## 演示保底方案（推荐现场用这个）

```bash
npm.cmd run build:web
# 然后双击 out/web/index.html
```

构建出来的 `out/web/` 是**自包含**的：单文件 IIFE 脚本、样式内联、相对路径。

- 不依赖 Node.js、不依赖本地服务器、不依赖网络
- 可以直接拷到 U 盘，在任何装了 Chrome/Edge 的电脑上双击打开
- 在 `file://` 下 localStorage 可用，数据能存住（已实测：答题→错因→落盘全通）

Electron 版本保留给"装得了的环境"用；演示现场**优先用这个**。

## 已经能跑通的链路

描述目标 → 确认范围 → 核对知识网 → 渐进摸底或直接查看规划 → 定位节点和开始今日任务 → 在检查点更新路径。

- **考纲骨架**：`resources/packs/gaokao-math-function.json`，42 个节点，含前置依赖、易混配对、考频权重、**每条关系的理由**
- **题库**：`resources/questions/gaokao-math-function.json`，30 道题，覆盖高权重考点
- **诊断摸底**：最多提交 10 次，可暂停后续做。至少 6 道不同的有效题，并覆盖 3 个主分支（不足 3 个时覆盖全部），才显示「已获得初步画像」。
- **掌握度模型**：覆盖 ×（0.6×能力 + 0.4×记忆保持），带可信度与保守收缩
- **证据与规划**：默认至少两道不同的近 30 天有效主考点题才判断薄弱或稳定。必要前置未知时先验证，薄弱时先补习。普通练习累计三道新有效题后，在会话结束时检查路径。今日最多三张卡并遵守剩余预算。

> 想直接进摸底：地址后加 `#diag`（如 `http://localhost:5180/#diag`），演示时方便。

### 可重复验收

1. 用 `start.bat` 打开网页，在大厅新建板块，输入「初二，想系统补齐一次函数，重点搞懂图像和性质」。核对学段、目标、纳入项和排除项后点「确认并生成」。预览检查主题与关联范围，再保存查看知识网。题目在开始检测或练习时准备。
2. 打开内置板块，跳过摸底，点右上角「规划」。在「接下来三步」和「查看整条路径」之间切换，点深层条目定位节点。切换热力表并返回，再试清除高亮、恢复高亮和关闭规划。
3. 开始摸底，交一题后暂停，刷新并继续。比较提交数、有效题数和主分支覆盖。在今日卡只答一题后查看任务，整场完成后再核对已完成项和路径版本。
4. 在已有作答的板块打开「范围与结构」，手动调整并预览。取消后重开，检查原节点和记录。重新改名或移动并应用，打开规划撤销修订，核对两次操作之间的作答仍在。
5. 在节点答疑中发送一条普通提问，再点「我还是不懂」。检查能力估计保持原值，规划可给出定点检测建议。实时请求会发送当前操作所需的范围、考点和题目上下文。

断网时可双击构建后的 `out/web/index.html` 验收内置板块、摸底和规划。自然语言拟定范围、知识网生成、补题和实时答疑需要新版 AI 代理。桌面版支持内置板块和规划，自定义板块与范围编辑在网页版使用。

## 两种运行方式共用一套代码

| | 桌面版 | 浏览器版 |
|---|---|---|
| 界面 | `src/renderer` | 同一份 |
| 领域算法 | `src/shared` + `src/main/domain` | 同一份 |
| 数据 | 主进程读写 `.data/data/state.json` | `localStorage` |
| 入口 | `src/preload` 暴露 `window.api` | `src/renderer/src/local-api.ts` 顶替 |

`app.ts` 里只有一行判断：有 `window.api` 就用它，没有就退回本地实现。

## 目录

```
src/
  shared/         类型 + 掌握度公式（主进程与渲染进程共用同一份）
  main/
    index.ts      窗口、IPC 白名单
    service.ts    读写状态、判分、更新掌握度
    domain/       纯函数：mastery / priority / queue / grading（可单测）
  preload/        只暴露 6 个动作，渲染进程拿不到 fs
  renderer/
    src/graph.ts    环形图渲染（极坐标树 + 螺旋连线 + 折叠第三层）
    src/app.ts      界面与交互
    src/local-api.ts 浏览器模式的数据层
resources/        考纲包、题库
tests/            36 条单测
docs/             设计报告与可视化原型
```

## 发版清单（每次改完必做）

用户第一次进入、以及**每次版本变化后**，都会看到一份使用指南；指南和版本号是绑死的。

1. 改 `src/renderer/src/guide.ts` 的 `GUIDE_STEPS` / `GUIDE_RULES`，把新功能写进去
2. 在 `GUIDE_RELEASES` 顶部加一条本次更新（版本号 + 日期 + 改动列表）
3. `GUIDE_VERSION` 与 `package.json` 的 `version` 同时升
4. `npm test` —— 版本号不一致、或最新更新条目为空，测试会直接失败

这套约束写在 `tests/guide.test.ts` 里，不靠自觉。

## 数据

- 桌面版：`项目根/.data/data/state.json`（已 gitignore），删掉即重置
- 浏览器版：清空站点数据即重置
- 使用指南的"已读版本"存在 `localStorage` 的 `gapgraph.guide.seen`

## 已知边界（v0.2.0）

- 只做了一个板块（函数）的一科内容；换学科是替换 `resources/` 里的两个 JSON
- 错因归因（F7）、AI 讲解与卡片（F9）、题源导入（F11）尚未接入
- 每个考点固定给 3 道题，尚未做单点自适应练习（摸底已经是自适应的）
- 存储用 JSON 文件（桌面版）与 localStorage（浏览器版），未上 SQLite；表结构已在设计文档里规划好
- 未做 electron-builder 打包
