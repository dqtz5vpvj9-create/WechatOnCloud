# 云微桌面端

这是云微的 Tauri 2 桌面壳。业务界面继续由线上云微提供，桌面壳负责系统托盘和窗口生命周期。

## 当前行为

- 启动后打开 `https://wechat.tail.lixinrui000.cn/`
- 单击关闭按钮时隐藏窗口并继续驻留托盘
- 单击或双击托盘图标恢复微信桌面；点击悬浮窗消息或系统通知打开对应实例的微信桌面
- 托盘菜单提供“打开云微”和“退出”
- 再次启动时唤醒已有窗口，避免产生多个实例
- 新消息在 Windows 任务栏或 macOS Dock 显示未读数字，托盘／菜单栏图标闪烁并发送系统通知
- 微信免打扰会话由服务端过滤，不触发桌面提醒
- 托盘悬浮窗使用真实头像和紧凑双行列表；按会话标识累计新消息，同名会话独立显示，超过五行可滚动
- 窗口重新获得焦点后自动清除未读徽标

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
