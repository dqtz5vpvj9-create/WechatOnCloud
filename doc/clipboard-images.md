# 复制云端图片到本机

在应用里复制图片后，打开云微的「剪贴板」，点击「复制图片到本机」。成功提示仅在图片已写入本机剪贴板后出现，随后可在本机应用粘贴。失败会显示原因，复制操作不会触发文件下载。

此入口按上游 PR #162 适配。它读取当前微信或 WeFlow 显示会话的剪贴板，复用该会话的输入锁和临时剪贴板归还逻辑。需要 HTTPS 或 localhost，以及支持 PNG 写入的浏览器。KasmVNC 的 PNG 自动同步仍按现有配置关闭。

接口 `GET /api/instances/:id/clipboard-image` 要求已登录且有实例访问权限，返回禁止缓存的 PNG；通过 `x-woc-screen` 选择已有显示会话。读取设置超时和 64 MiB 上限，并拒绝缺少 PNG 结尾的截断数据。

验证命令：

```sh
cd desktop
npx e2e run --config e2e.panel.config.ts
```

浏览器测试使用生成图片和隔离 API，真实调用浏览器剪贴板写入、读回并核对像素。原生 PNG 测试在浏览器明确不支持该能力时跳过；权限拒绝、能力缺失、没有图片的失败行为另有测试。Windows 版 Playwright WebKit 不支持 PNG 剪贴板，Safari 的真实写入验证需在 macOS 上运行同一套测试。

```sh
cd panel/server
WOC_CLIPBOARD_TEST_IMAGE=<本机已有的实例镜像> node --import tsx --test tests/clipboard-image.integration.ts
```

Docker 集成测试要求可访问 Docker、Node 22.15 或更新版，创建并清理独立容器。验证双显示隔离、超过 1 MB 的图片读取、无感输入后的图片归还、纯文字和截断图片错误。
