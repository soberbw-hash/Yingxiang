# 映箱 Yingxiang

映箱（原 Weave）是一款用于视频创作的本地素材管理工具，提供素材库、自由画布、剪辑对照、项目备份与可选的共享图片库。

## 下载

Windows 使用者请从 [Releases](https://github.com/soberbw-hash/Yingxiang/releases) 下载最新的 `Weave-Windows-v*.zip`，解压后运行 `Weave\Weave.exe`。这是便携版，不需要安装器；公司设备的执行和联网限制仍以 IT 策略为准。

浏览器版可从同一 Release 下载 `Weave-Browser.zip`。它使用当前浏览器本地存储，不具备桌面版的后台文件夹观察等能力。浏览器版不会与桌面版自动同步项目数据。

## 自动更新

Windows 便携版启动时检查公开 Release。发现新版后自动下载 ZIP 并校验 SHA-256；之后请关闭软件，将 ZIP 内的 `Weave` 程序目录替换到原程序位置，再重新启动。项目数据保存在独立项目目录，不要覆盖项目目录。更新不请求管理员权限，也不会绕过公司安全策略。

## 从源码构建

需要 Windows、Node.js 与 pnpm。克隆仓库后执行：

```powershell
pnpm install
pnpm build
pnpm test:updates
pnpm package:desktop -- --zip
```

打包脚本使用当前安装的 Windows Electron 运行时，在 `release/` 中生成便携目录和 ZIP。完整构建/验收说明见 [Windows 使用说明](WEAVE-使用说明.md) 与 [浏览器版说明](docs/BROWSER-EDITION.md)。

## 项目数据

项目默认保存在用户选择的本地项目文件夹，更新程序文件不会修改这些文件夹。建议定期使用应用中的项目备份功能，并将备份保存在独立位置。

## 许可

仓库当前未附 Weave 源码的开源许可；公开仓库用于阅读和下载，不自动授予复制、修改或再分发 Weave 源码的权利。内置 HarmonyOS Sans 字体按其附带的华为许可单独授权。
