# 复制云端图片到本机

在云微 Windows 或 macOS 桌面客户端中，对微信或 WeFlow 里的图片执行复制，即可在本机应用粘贴。读取较慢时显示状态；传输开始且已知长度后显示实际传输进度。复制期间若本机剪贴板被其他操作更新，旧图片不会覆盖新内容。

网页端保留剪贴板抽屉中的「复制图片到本机」。Safari 的自动图片复制仍需处理浏览器的剪贴板用户手势限制；文字剪贴板路径保持独立。

服务端通过 XFixes 监听当前显示会话的剪贴板变化，仅在桌面客户端检测到近期复制操作后读取图片。PNG 通过独立接口读取，避免开启 KasmVNC 的大图同步路径。读取限制为 64 MiB，原生解码限制为 3200 万像素，并拒绝截断 PNG。`GET /api/instances/:id/clipboard-image` 和 `clipboard-events` 均要求实例访问权限，`x-woc-screen` 区分显示会话。

验证：

```sh
cd desktop
npx e2e run --config e2e.panel.config.ts
```

浏览器测试覆盖自动触发、文字复制保护和延迟传输状态。桌面客户端测试还需交互式桌面：`tests/native-clipboard-image.e2e.ts` 验证实际操作系统剪贴板的图片写入与后续本机复制保护；Windows 辅助脚本会保存并恢复原剪贴板。

```sh
cd panel/server
WOC_CLIPBOARD_TEST_IMAGE=<已有实例镜像> node --import tsx --test tests/clipboard-image.integration.ts tests/clipboard-watch.integration.ts
```

Docker 集成测试使用独立临时容器，覆盖双显示隔离、超过 1 MB 图片、文字和截断图片，以及监听断开后的进程退出。
