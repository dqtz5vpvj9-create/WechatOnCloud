# 云微桌面端

这是云微的 Tauri 2 桌面壳。业务界面继续由线上云微提供，桌面壳负责系统托盘和窗口生命周期。

## 当前行为

- 启动后打开 `https://wechat.tail.lixinrui000.cn/`
- 单击关闭按钮时隐藏窗口并继续驻留托盘
- 单击或双击托盘图标恢复微信桌面；点击悬浮窗消息或系统通知打开对应实例的微信桌面
- 托盘菜单提供“打开云微”和“退出”
- 再次启动时唤醒已有窗口，避免产生多个实例
- 全局快捷键 Windows `Alt+W` / macOS `Option+W`：前台时隐藏，隐藏或后台时唤起
- 文件可直接拖入「文件传输」上传；下载保存到系统「下载」文件夹并提示结果，同名文件自动编号
- macOS 无感输入兼容：修正触摸板轻点的按下／松开乱序，松开后停止远端拖动；点击画面不会请求读取本机剪贴板，使用 `Command+V` 粘贴
- 新消息在 Windows 任务栏或 macOS Dock 显示未读数字，托盘／菜单栏图标闪烁并发送系统通知
- 微信免打扰会话由服务端过滤，不触发桌面提醒
- 托盘悬浮窗使用真实头像和紧凑双行列表；按会话标识累计新消息，同名会话独立显示，超过五行可滚动
- 已读和忽略状态由服务端同步到各设备，窗口聚焦保留其他会话未读
- 启动和每六小时自动检查桌面更新；有新版时提示“更新并重启”，托盘菜单也可手动检查

## 应用内更新（0.2.0 起）

旧版需安装一次 0.2.0，此后可在应用内完成更新。Windows 推荐使用安装包安装，macOS 将应用放入可写的 Applications 目录后运行。更新检查从固定 `desktop-stable` Release 获取清单，安装包使用版本化 Release 链接，并由内置公钥验签。

发布时同时修改 `src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 版本，再推送 `desktop-vX.Y.Z` 标签。`desktop-release` 工作流构建 Windows x64 与 macOS Universal，两个平台的包及签名齐全后才更新通道。回滚应以更高版本号重发已知正常代码，保留旧版本的 Release 资产。

签名私钥保存在仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`，本机备份位于用户 `.tauri/yunwei-updater.key`。私钥禁止入库，丢失后已安装客户端无法信任新密钥生成的更新。此签名校验更新包来源；macOS 当前仍为 ad hoc 签名，未经过 Apple 公证，首次安装的系统放行仍需要用户操作。

## 自动化测试通道

正常启动不会开放调试端口。Windows 传入 `--automation-port=<端口>` 后，应用仅在 `127.0.0.1` 开放 WebView2 CDP，供 Playwright/e2e 驱动；自动化实例同时跳过单实例限制。该测试通道依赖 WebView2，macOS 使用 WKWebView，尚未配置同类 GUI 自动化。

端到端登录测试从环境变量读取凭据：

```powershell
$env:E2E_USER_ADMIN_USERNAME = 'admin'
$env:E2E_USER_ADMIN_PASSWORD = '<password>'
npm run test:e2e
```

测试默认使用 `.e2e/webview-profile` 隔离登录态。设置 `WOC_E2E_PROFILE=app` 可操作桌面应用的正式配置目录。

悬浮窗回归测试无需账号：`npx e2e run tests/tray-preview.e2e.ts`。测试通过隔离实例调用真实悬浮逻辑，验证计数、头像、尺寸、滚动和点击，截图保存到 `test-results/tray-preview/`。

分别运行 `npx e2e run tests/native-files.e2e.ts` 和 `npx e2e run tests/shortcut.e2e.ts`，验证文件拖入、原生下载落盘、同名文件保护和系统级 Alt+W。每条命令创建独立的原生应用会话。测试使用生成的文件及隔离 API，不发送微信消息。全局快捷键测试需要 Alt+W 未被其它进程占用；正式应用拥有该快捷键时，先退出正式应用再运行测试。

真实云端文件往返测试：设置 `WOC_E2E_PROFILE=app` 和 `WOC_LIVE_FILES_INSTANCE=<已授权实例 ID>` 后运行 `npx e2e run tests/native-files-live.e2e.ts`。复用已有登录态，只上传生成的测试文件，校验下载内容后删除该测试文件。

WebKit 输入回归：`npx playwright install webkit` 后运行 `npx e2e run --config e2e.webkit.config.ts`。测试使用 KasmVNC 原版鼠标捕获模块，覆盖触摸板事件乱序、焦点重入、丢失松开、正常拖动、连续点击、多按钮、剪贴板与文件拖入。设置 `WOC_INPUT_GUARD=0` 可验证修复前的失败。乱序事件由测试重放，物理触摸板与具体输入法的行为仍以设备实际事件为准。

Safari 和桌面壳共用 `panel/web/public/webkit-input.js`。异常修正会向现有实例日志写入少量 `[webkit-input v1]` 事件证据（按钮、时间戳、输入模式），不包含按键、剪贴板或聊天内容。相关上游报告：[WebKit #219670](https://bugs.webkit.org/show_bug.cgi?id=219670#c32)、[Tauri #7219](https://github.com/tauri-apps/tauri/issues/7219)。

## Windows 构建

需要 Node.js、Rust MSVC 工具链、Microsoft C++ Build Tools 和 WebView2。首次构建：

```powershell
cd desktop
npm install
npm run build
```

安装包位于 `src-tauri/target/release/bundle/`，独立可执行文件位于 `src-tauri/target/release/yunwei.exe`。

## macOS 构建

GitHub Actions 的 `desktop-macos` 工作流生成 macOS 12 及以上可用的通用包，包含 Apple Silicon 和 Intel 两种架构。推送 `main` 或 `desktop/**` 分支中的桌面代码会触发构建，也可手动运行。

在 Actions 运行页下载 `yunwei-macos-universal` artifact，内含 `.dmg`、保留可执行权限的 `.app.zip`、构建信息和 SHA-256 校验文件。打开 DMG 后将云微拖入 Applications。

当前使用 ad hoc 签名，未进行 Apple 公证。首次打开若被 macOS 拦截，前往「系统设置 → 隐私与安全性」允许打开。应用连接上述云微服务，Mac 需要能访问该 Tailnet 地址。

在装有 Xcode Command Line Tools 的 Mac 上手动构建：

```sh
cd desktop
npm ci
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build -- --ci --target universal-apple-darwin --bundles app,dmg
```

工作流验证两种二进制架构、应用签名、DMG 完整性和 Rust 单元测试。通知、菜单栏悬浮窗与云端连接的交互仍需 macOS 环境实测。
