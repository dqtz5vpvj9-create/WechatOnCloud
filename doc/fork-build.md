# 构建和部署本 fork

仓库：[dqtz5vpvj9-create/WechatOnCloud](https://github.com/dqtz5vpvj9-create/WechatOnCloud)。

本 fork 增加了[手机聊天记录迁移配置](chat-migration.md)和[微信启动环境过滤](runtime-environment.md)。原来的 `docker-compose.yml` 仍引用上游镜像；只下载这个文件并启动，得到的程序不会包含本 fork 的修改。

## 新部署

需要 Docker Engine 和 Compose。以下命令构建本机架构的两个镜像，不向任何镜像仓库发布内容。

```bash
git clone https://github.com/dqtz5vpvj9-create/WechatOnCloud.git
cd WechatOnCloud
cp .env.example .env
```

编辑 `.env` 设置管理员密码 `WOC_PASSWORD`，并按原部署文档配置存储、时区和面板端口。接着执行：

```bash
WOC_IMAGE_PREFIX=ghcr.io/dqtz5vpvj9-create WOC_VERSION=dev-local ./scripts/build-local.sh
docker compose -f docker-compose.yml -f docker-compose.fork.yml up -d
```

覆盖文件固定使用本 fork 的镜像命名空间，面板的 `pull_policy: never` 会在未完成本地构建时明确失败。构建脚本和覆盖文件的默认标签均为 `dev-local`。这里使用 GHCR 格式命名本地镜像，不代表该标签已发布到 GHCR。

如果希望保留多个版本，在同一个终端先执行 `export WOC_FORK_TAG=dev-$(git rev-parse --short HEAD)`，构建时把 `WOC_VERSION=dev-local` 改成 `WOC_VERSION="$WOC_FORK_TAG"`。后续 Compose 命令也需要相同的 `WOC_FORK_TAG`；跨终端使用时将它写入 `.env`。

## 更新已有部署

先备份面板账号目录和要保留的实例数据卷，沿用原部署的 Compose 项目目录、`data-panel` 和实例卷。重新拉取 fork 源码，按上面的命令构建两个镜像并重建面板。

这两项改动的生效条件不同：

| 修改 | 生效条件 |
| --- | --- |
| 迁移端口配置、状态和检查 | 更新面板镜像；适用于已有微信实例 |
| 微信启动环境过滤、移除构建期脚本 | 更新微信实例镜像；只重建面板不会更新实例文件系统 |

在管理页对已有微信实例执行明确的“升级实例”，确认实际镜像 ID 已变为刚构建的本地镜像。普通“重启”会沿用旧镜像，这是保留版本的预期行为。上游的升级流程会先尝试拉取远端标签；本地标签尚未发布时会回退到本地镜像，网络失败可能需要等待。更新后再次检查迁移配置和实际映射。

本地构建版本的更新方式是重新构建并通过上述 Compose 覆盖文件部署。面板里的“更新面板”走镜像仓库拉取，不能代替本地源码构建。所有后续 Compose 操作都应带上两个 `-f` 参数，避免恢复为上游镜像配置。

## 回退

保留更新前的两个镜像 ID 和数据备份。需要回退程序时，在独立的 Compose 覆盖文件中把面板 `image` 和 `WOC_WECHAT_IMAGE` 指向保留的镜像引用，再部署。旧面板不会应用新增加的迁移声明；回退后应检查宿主机 8015 映射是否仍存在，并按需要关闭。程序回退不等于微信数据库格式回退，升级前的数据备份仍需保留。
