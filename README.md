# OpenCode Session Editor

用于查看和编辑本机 OpenCode 会话的桌面工具。修改通过 `opencode import` 另存为新会话，原会话保持不变。

工具调用默认折叠。点击工具摘要后，可分别展开输入、输出；左侧原始内容只读，右侧可编辑。JSON 输入会格式化显示并校验，长内容在编辑框内滚动；工具输出支持普通文本和 JSON 文本，失败调用也可修改错误输出。折叠或执行其他编辑操作时会保留草稿；存在格式错误时无法保存。

## macOS 应用

双击 `dist/OpenCode Session Editor-darwin-arm64/OpenCode Session Editor.app` 即可运行，也可以将它拖到「应用程序」目录。应用内置 Bun，无需开启终端或浏览器；本机仍需安装 OpenCode。

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
```

`npm run build` 将当前机器的 Bun 运行时和后端代码放进应用，输出到 `dist/`。构建产物不依赖本项目的源代码目录。

Electron 主进程位于 `electron/main.cjs`；通过 `electron/runtime.cjs` 启动独立 Bun 后端，并在随机本地端口等待就绪。桌面请求带有每次启动随机生成的令牌。前端使用隔离且启用沙箱的渲染进程，通过有限的 preload 接口访问目录选择和剪贴板。

测试使用临时 SQLite 数据库和模拟 OpenCode CLI，覆盖启动、访问校验、读取、克隆、临时文件清理和退出行为，不写入真实会话。

## 原有浏览器方式

仍可运行 `bun run src/server.ts`，或使用 `./install.sh` 安装的 `ocedit` 命令。`shortcut.sh` 创建的是原有终端启动快捷方式；使用桌面版时直接打开 `.app`。
