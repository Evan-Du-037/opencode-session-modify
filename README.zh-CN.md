# OpenCode Session Editor

[English](README.md) | 简体中文

用于查看和编辑本机 OpenCode 会话的桌面工具。自动识别 OpenCode v1/v2，修改通过官方导入命令另存为新会话，原会话保持不变。已用本机 OpenCode **v2.0.26** 验证。

v2 使用 `opencode debug paths` 定位数据库，只读查询 `session_v2` / `session_message`；读取和保存使用 `opencode session export/import`。工具输出按 v2 的 `content` JSON 数组编辑（文本位于 `text` 字段），错误按结构化 JSON 编辑。附件、模型切换、系统消息及压缩记录随副本保留；压缩记录的 summary/recent 可编辑，其他事件详情只读。v2 的官方导出仅包含已完成的消息，正在生成的回答需等完成后重新打开。旧 v1 数据需先由 OpenCode 迁移到 v2 才会出现在 v2 列表中。

工具调用默认折叠。点击工具摘要后，可分别展开输入、输出；左侧原始内容只读，右侧可编辑。JSON 输入会格式化显示并校验，长内容在编辑框内滚动；v1 工具输出支持普通文本和 JSON 文本，v2 工具输出使用上述 content 数组；失败调用也可修改错误输出。折叠或执行其他编辑操作时会保留草稿；存在格式错误时无法保存。

## Windows 桌面应用

双击 `dist/OpenCode Session Editor-win32-x64/OpenCode Session Editor.exe`。必须保留整个应用目录，包括旁边的 DLL 和 `resources`；可以整体移动目录，并为 `.exe` 创建快捷方式。应用内置 `bun.exe`，运行时不需要浏览器、终端或另装 Bun。

本机仍需安装 OpenCode。应用查找 PATH、用户的 Bun/OpenCode bin 目录，以及 `%APPDATA%/npm`，并识别 npm 安装的 `@opencode/cli/bin/opencode.exe`。非标准安装可通过 `OCEDIT_OPENCODE` 指定完整的 **`.exe` 路径**，不要指向 `opencode.cmd`。

支持单实例、原生目录选择、剪贴板、未保存修改提示和关闭时清理后端；目录筛选兼容 Windows 反斜杠和 OpenCode 存储的正斜杠。当前是未签名的便携应用目录。旧 Windows V1 实现在 `windows-v1` 分支，本分支基于支持 V2 的主线。

构建需要 Node.js 22.12 或更新版本、npm、Bun 和 OpenCode。在 PowerShell 执行：

```powershell
npm.cmd ci
npm.cmd start
npm.cmd test
npm.cmd run build

# 使用临时数据验证真实 V2 CLI 和打包后的桌面界面。
$env:OCEDIT_REAL_OPENCODE = "$env:APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe"
npm.cmd test
$env:OCEDIT_TEST_V2 = "1"
npm.cmd run test:app
```

打包应用不依赖源码目录。`install.sh` 和 `shortcut.sh` 属于旧的 Unix 浏览器启动方式，不用于安装 Windows 桌面版。

## macOS 应用

双击 `dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app` 即可运行，也可以将它拖到「应用程序」目录。应用内置 Bun，无需开启终端或浏览器；本机仍需安装 OpenCode。

- 重复打开应用会唤起已有窗口。
- 关闭最后一个窗口或按 `⌘Q` 会结束应用及其后台服务。
- 未保存的编辑在关闭或刷新窗口时会提示确认。
- 支持原生目录选择、剪贴板和标准编辑快捷键。
- 自动查找 PATH、`~/.opencode/bin`、`~/.bun/bin`、`~/.local/bin` 和 Homebrew 中的命令。
- 非标准安装路径可通过 `OCEDIT_OPENCODE` 指定 OpenCode 可执行文件。

当前产物面向本机构建架构，使用本地 ad-hoc 签名，未做 Developer ID 签名和公证。

## 开发与构建

需要 Node.js、npm、Bun 和 OpenCode。在 macOS 上执行：

```sh
npm ci
npm start
npm test
npm run build
npm run test:app

# 用本机真实 v2 CLI 做隔离测试，不写入真实会话
OCEDIT_REAL_OPENCODE="$HOME/.opencode/bin/opencode" npm test
OCEDIT_TEST_V2=1 npm run test:app
```

`npm run build` 将当前机器的 Bun 运行时和后端代码放进应用，输出到 `dist/`。构建产物不依赖本项目的源代码目录。若要保留旧版，可指定独立输出目录：

```sh
OCEDIT_BUILD_OUT=dist/1.1.0 npm run build
npm run test:app -- "dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app"
OCEDIT_TEST_V2=1 npm run test:app -- "dist/1.1.0/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app"
```

上述路径以 Apple Silicon 为例；构建脚本会使用当前机器的架构。桌面替身仍会指向创建时的 App，使用独立输出目录后，需为新版重新创建替身。

Electron 主进程位于 `electron/main.cjs`；通过 `electron/runtime.cjs` 启动独立 Bun 后端，并在随机本地端口等待就绪。桌面请求带有每次启动随机生成的令牌。前端使用隔离且启用沙箱的渲染进程，通过有限的 preload 接口访问目录选择和剪贴板。

v1 回归测试使用临时 SQLite 数据库和模拟 CLI；v2 集成测试使用真实 CLI、隔离的 XDG 数据/配置目录和临时服务器，覆盖读取、搜索、文本与工具编辑、克隆保存及重新导出，并校验原会话未变。所有测试都不写入真实会话。

## 原有浏览器方式

仍可运行 `bun run src/server.ts`，或使用 `./install.sh` 安装的 `ocedit` 命令。`shortcut.sh` 创建的是原有终端启动快捷方式；使用桌面版时直接打开 `.app`。
