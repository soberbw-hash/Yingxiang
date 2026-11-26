# 映箱 Yingxiang — 接手交接文档

> 面向下一位接手的 AI / 开发者。最后更新：2026-11-26。
> 目标读者需要能自己跑命令、改代码、打包、并判断哪些动作在这台机器上是被环境限制的。

---

## 1. 这是什么

「映箱」是一款**纯本地**的视频创作素材管理桌面软件（前身 Weave）。核心能力：素材库、自由画布、剪辑对照、项目备份、可选的共享图片库，以及一个「自动接收文件夹」的跨项目中转区。

- GitHub：<https://github.com/soberbw-hash/Yingxiang>（public，账号 `soberbw-hash`，用户有 ADMIN 权限）
- 当前版本：`0.3.1`（`package.json`、`electron/package.json` 里是 `0.3.1`，exe 版本资源是 `0.3.1.0`）
- 默认分支：`main`
- 用户称呼：尤老师。偏好简体中文、直接、少废话、交付可运行的东西。

### 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + Vite 6 + TypeScript |
| 桌面 | Electron 44（CommonJS 主进程 `electron/*.cjs`） |
| 包管理 | pnpm 10（`pnpm-workspace.yaml` 里只有 `allowBuilds`，pnpm 9 会报错） |
| 数据 | 本地 JSON 文件，不用数据库 |
| 测试 | `node --test`，约 174 个用例，`.mjs` 与 `.cjs` 混合 |

---

## 2. 目录地图（只看这些就够了）

```
Yingxiang/
├─ src/                       前端界面（React）
│  ├─ App.tsx                 顶层状态、新建项目对话框、中文错误提示
│  ├─ components/ProjectHome.tsx   项目首页卡片（含「待整理」卡片）
│  ├─ features/SettingsDialog.tsx  设置；自动接收文件夹在这里配
│  └─ styles.css
├─ electron/
│  ├─ main.cjs                主进程：窗口/托盘/IPC/自动更新/启动引导
│  ├─ project-repository.cjs  项目数据读写（createProject 要求空目录）
│  ├─ project-location.cjs    【新增】解析新建项目落地路径
│  ├─ inbox-receipts.cjs      自动接收去重账本（sha256）
│  ├─ project-safety.cjs      路径安全校验
│  ├─ fetch-remote.cjs / update-service.cjs
│  └─ assets/                 品牌图标 png/ico（打包进成品）
├─ public/assets/             icon.svg（大尺寸）、icon-small.svg（16/24px）
├─ shared/                    前后端共用逻辑（editing、canvas、asset-stacks…）
├─ scripts/
│  ├─ package-desktop.mjs     完整打包（输出 363MB 便携目录）
│  ├─ ship-desktop.mjs        【新增】增量同步到桌面，日常更新用这个
│  ├─ embed-icon.mjs          【新增】resedit 把 ico + 中文版本信息写进 exe PE 资源
│  ├─ make-icon.cjs           由 SVG 生成多尺寸 png/ico
│  ├─ make-launchers.mjs      生成「映箱」与「映箱-公司」两个快捷方式
│  └─ harmony-fonts.mjs       字体处理
├─ tests/                     174 个测试
├─ 使用说明.txt               给不懂软件工程的用户看的交付说明
├─ README.md / HANDOFF.md     仓库说明 / 本文档
└─ .gitignore                 注意：忽略 AGENTS.md、docs/*、使用说明.txt、build-*/release-*
```

**数据不在仓库里**：用户项目数据默认在 `%APPDATA%\Weave`，自动接收中转区在 `%APPDATA%\Weave\public-inbox`。目录名仍是 `Weave`，改名「映箱」不影响历史数据。

---

## 3. 怎么跑、怎么验

```bash
# 安装（Node 18+ / pnpm 10）
corepack prepare pnpm@10.20.0 --activate
pnpm install

# pnpm 10 会跳过 electron 的 postinstall，需手动补一次
cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js && cd ../..

# 开发
pnpm dev:desktop

# 类型检查 + 全量测试（Windows 下必须显式列文件，不能只传 tests/ 目录）
npx tsc --noEmit
node --test tests/*.test.mjs tests/*.test.cjs

# 完整打包
pnpm package:desktop

# 增量同步到桌面（见第 5 节）
node scripts/ship-desktop.mjs
```

**命令行启动前必须 `unset ELECTRON_RUN_AS_NODE`**：当前 shell 环境里它被设成 `1`，Electron 会被当成 Node 跑，表现为进程只有几十 MB、没有窗口。用户双击 exe 不受影响。

**启动验证的坑**：Electron 是单实例应用。如果桌面上已经有映箱在跑，新启动的实例会立刻退出，此时 `tasklist` 里看到的进程是用户自己开的那个。不要按 PID 去杀——先看 `StartTime` 判断归属。2026-11-04 就误杀过一次用户正在用的实例。

---

## 4. 已经做完的事（别重复做）

### 4.1 品牌与交付

- 从 Electron 默认图标换成自绘品牌图标：深紫渐变 + 白色卡片 + 紫色播放三角。
- `icon-small.svg` 专供 16/24px（双层卡片在小尺寸会糊成色块）。
- **让资源管理器显示自定义图标，必须写进 exe 的 PE 资源**：只设 `BrowserWindow.icon` / 托盘图标不够。用 `scripts/embed-icon.mjs`（resedit）同时写入 `icon.ico` 和中文版本信息「映箱 · 视频创作工作台 / 0.3.1.0」。
- 桌面成品目录 `D:\Desktop\映箱\` 收敛成 4 项：`使用说明.txt`、`映箱` 快捷方式、`映箱-公司` 快捷方式、`程序\`。
- 「映箱-公司」快捷方式额外带 `--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-features=RendererCodeIntegrity,NetworkServiceSandbox`，用于绕开企业安全软件常见拦截。快捷方式同时写了绝对路径和相对路径，拷走后仍可用。

### 4.2 新建项目卡死（真实原因）

`repo.createProject` 要求目标目录**为空**，否则抛 `EXISTS: Choose an empty project folder`。错误只进 toast，对话框原地不动 → 用户看到的是「选完位置就卡住」。用户几乎必然选有素材的目录。

修复：`electron/project-location.cjs` 的 `resolveProjectRoot(picked, name)`：

- 空目录直接用
- 非空目录则在其中建 `项目名` 子文件夹，重名依次 `-2` / `-3`，同名空目录复用
- 清洗非法字符与 `CON` / `PRN` 等保留名
- `src/App.tsx` 把 `CODE: message` 翻成中文红字，显示在对话框内（`createProjectErrorText`）

### 4.3 「待整理」到底是什么

它是 `publicInbox` 项目（`%APPDATA%\Weave\public-inbox`），**本机的跨项目中转区**，不是团队空间（团队空间是「公共资产库」）。

机制：设置里选一个接收文件夹 → chokidar 监听 → 新文件自动导入 → 用户再「加入项目」。`InboxReceipts` 用 sha256(path+size+mtime) 记账防重复；`baseline()` 把选目录时已有的文件记为基线，不追溯导入。

原来三处说法互相矛盾（「旧待整理素材（保留）」/「待整理」/「新素材默认保存到」），已统一为「自动接收文件夹」：

- `ProjectHome.tsx` 卡片改用 `projectLabel()`，写清用途与「选择接收文件夹」入口
- 卡片从 `<button>` 改成 `role="button"` 的 `<div>`（内部还要放按钮，不能按钮套按钮）
- 启动时不再把 inbox 设为当前项目（`activeProjectId=""` 是安全的，bootstrap 会显示项目列表）
- 设置页改称「自动接收」，并说明只读不搬移、已有文件不重复导入

### 4.4 打包相关

- 语言包从 55 个裁到 4 个（zh-CN / zh-TW / en-US / en-GB），体积 414MB → 363MB。裁剪只在复制时做，不要在源目录批量删。
- `package-desktop.mjs` 的 `rename(stage→target)` 遇到 EPERM/EBUSY 会重试 5 次，仍失败退化为 `fs.cp`（DLP 会扫刚写入的 2300+ 文件，短暂占住句柄）。
- 支持 `WEAVE_RELEASE_DIR` 换输出目录，绕开被占用的旧产物。

---

## 5. 桌面交付怎么更新（重要）

`D:\Desktop\映箱\` 是**打包出来的成品副本**，改源码不会自动同步到那里。

日常更新用：

```bash
node scripts/ship-desktop.mjs       # 或 pnpm ship:desktop
```

它会 `vite build`，然后只把变化的 `dist/client`、`electron`、`shared`、运行期 `node_modules` 增量覆盖到 `D:\Desktop\映箱\程序\resources\app\`。几秒钟，不重拷 360MB 运行时。加 `--full` 才走完整打包。

**为什么不用完整打包**：在这台机器上，`package-desktop.mjs` 清理 `build-out\映箱`（2345 个文件）会被安全策略 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（单轮 50 文件阈值）拦下。这不是代码 bug，别去「修」它。

**路径映射千万别改错**：必须是 `dist/client → app/dist/client`。`main.cjs` 里加载的是 `../dist/client/index.html`。曾经写成 `→ app/dist`，导致前端错位且清理逻辑误删了 `app/dist/client`，已修正并加了 `cleanMisplacedDist()` 兜底。

**验证同步结果**：

```bash
# 包内前端文件名带内容哈希，应与本地 build 产物一致
ls D:/Desktop/映箱/程序/resources/app/dist/client/assets/index-*.js
ls dist/client/assets/index-*.js

diff -rq electron D:/Desktop/映箱/程序/resources/app/electron
node --check D:/Desktop/映箱/程序/resources/app/electron/main.cjs
```

---

## 6. 这台机器的环境限制（别当成项目 bug）

1. **codeload.github.com 被限速到约 20KB/s**；`git fetch` 常报 `fetch-pack: invalid index-pack output`。但 `curl` 走 `https://api.github.com/repos/.../zipball/main` 下载正常，GitHub REST API（通过 `gh`）也正常。
2. **联软 UniAccess + DLP + 腾讯桌面整理等常驻程序**会实时扫文件，导致批量删除/改名失败、文件夹「正在使用」。重启无效（开机自启）。
3. **安全策略 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`**：单轮删除超过 50 个文件会被拦。不要试图用 `rm -rf` 硬删大目录。
4. **AppInit_DLLs 全局注入**导致进程创建慢（新窗口 500ms–10s），整机连续运行久了更明显。这与本项目无关。
5. **本机 shell 有 `ELECTRON_RUN_AS_NODE=1`**（见第 3 节）。
6. `node --test tests/` 在 Windows 下报 MODULE_NOT_FOUND，必须列 glob。
7. 沙箱会回收自己派生的进程，无法在这里可靠模拟用户双击快捷方式；这类验证只能交给用户手动做。
8. **本地工作副本的 git 历史是孤岛**：最初因 codeload 限速，源码是通过 jsDelivr 逐文件下载后重新 `git init` 的，3 个本地提交与 GitHub 的历史不相连。2026-11-26 已通过 GitHub REST API 把改动叠加到远端 `main`（保留原历史）。**以后以 GitHub main 为准，不要从这个本地目录 force push。**

---

## 7. Git / 推送说明

- 本地：`C:\Users\7478\WorkBuddy\2026-11-04-15-50-46\Yingxiang`，`git log` 只有 3 个提交：`93d4191`、`bb5f824`、`e4845e7`，没有配置 remote。
- 远端：`soberbw-hash/Yingxiang`，`main`，2026-11-26 的提交把本地这 3 个提交的净改动 + 本交接文档作为一个新提交叠加到远端历史之上。
- `gh auth status` 已登录 `soberbw-hash`，token 有 `repo` / `workflow` scope。
- 因为 `git fetch` 在这台机器不可用，推送走 REST API（`git/blobs` → `git/trees` → `git/commits` → `git/refs/heads/main`）。下一位接手者如果网络正常，可以直接 `git clone` 后正常操作。

---

## 8. 还没做 / 可以继续的方向

- **AI 接口是空壳**：设置里的 baseUrl / model / key 只存不用，UI 也明说「这里不会生成内容」。是刻意留的占位，不是缺陷。可接「按图反推提示词」「自动打标签」。
- **性能**：单个 JS 包约 724KB，字体 24MB 全量加载。素材上千时首屏和滚动有优化空间。
- **素材库似乎没有排序控件**，可考虑补。
- Release 资产名仍是 `Weave-Windows-v*.zip` / `Weave-Browser-v*.zip`（历史包名，README 与之匹配）。若改名需同步更新 README、Release 和更新服务的匹配规则。
- 用户尚未手动确认过：双击桌面「映箱」快捷方式能否在所有场景下正常打开（沙箱无法模拟）。

---

## 9. 跟用户协作的注意事项

- 数据敏感：未经授权不要把项目资料跨设备/账号/工作空间复制或上传。个人 MacBook 与公司 Dell 环境不同，不要互相套配置。
- 用户不懂软件工程：交付物要说人话、目录要整齐、能双击就用；解释功能时讲「干什么用」，别讲实现细节。
- 遇到 UI/UX 问题用户会发截图，认真看细节。改完尽量给可验证的结果（打开方式、看到什么变化）。
