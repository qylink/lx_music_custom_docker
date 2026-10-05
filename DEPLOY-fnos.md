# 飞牛 OS（FnOS / NAS）部署指南

本文档面向飞牛 NAS 用户。**只想在本地电脑跑**的话，看 [README 快速开始](./README.md#1-快速开始新手看这里) 就够了。

飞牛系统自带 Docker 套件，支持 `docker compose`，下面三种方式任选其一。

---

## 部署前准备

| 项目 | 说明 |
| --- | --- |
| Docker 套件 | 飞牛桌面 → 应用中心 → 安装「Docker」，已装则跳过 |
| 项目文件 | 下载本项目 zip，解压后目录内应包含 `docker-compose.yml`、`.env.example` |
| 存放目录 | 建议 `/vol1/1000/docker/lx-music-docker`（下文统一用这个路径） |
| 端口 | 默认 `3210`，需在飞牛防火墙 / 反代中放行 |

> 数据（数据库、音源、下载的音乐）都在项目目录的 `data/` 下，升级、重装容器都不会丢。

---

## 方式一：飞牛 Docker UI（图形界面）

最省事，全程鼠标操作。

1. 把项目 zip 上传到飞牛共享目录并解压到 `/vol1/1000/docker/lx-music-docker`
2. 飞牛桌面 → **Docker** → **项目管理** → **新建** → **本地创建**
3. 填写：

   | 字段 | 填写内容 |
   | --- | --- |
   | 项目名称 | `lx-music-docker` |
   | 路径 | `/vol1/1000/docker/lx-music-docker` |

4. 确认该目录下存在 `docker-compose.yml`（和可选的 `.env`），提交
5. 等待状态从 `Created` 变为 `Running`
6. 浏览器打开 **http://飞牛IP:3210**

> 若飞牛开启了 HTTPS 反代，首次访问需要放行 `3210` 端口。

---

## 方式二：SSH 命令行

最直接，便于后续升级维护。

```bash
# 1. 登录飞牛
ssh <你的用户名>@<飞牛IP>

# 2. 进入 docker 目录并上传项目
cd /vol1/1000/docker
# 二选一：
#   a) git clone
git clone <本项目仓库地址> lx-music-docker
#   b) 或用 scp / 共享目录把 zip 传上来后解压
# mkdir -p lx-music-docker && unzip lx-music-docker.zip -d lx-music-docker

cd lx-music-docker

# 3.（可选）生成配置，按需修改
cp .env.example .env
vi .env          # 常用项：HTTP_PORT 端口、MUSIC_BIND 音乐目录、NETEASE_MUSIC_U

# 4. 首次启动（本地构建镜像，无需镜像仓库账号）
docker compose up -d --build

# 5. 查看日志，看到这行即成功
docker compose logs -f
#   Listening on 0.0.0.0:3210
```

**关于 `--build`**

- 首次部署保留它，会用项目自带的 `Dockerfile` 本地构建镜像
- 已有构建好的镜像时可省略，直接 `docker compose up -d`
- 用私有 / 局域网镜像仓库时，在 `.env` 里设置 `LX_IMAGE=你的镜像地址` 即可跳过构建

---

## 方式三：飞牛「自建应用」

飞牛 0.8+ 支持把任意 compose 项目显示为一个应用图标。

1. 按方式一创建并启动项目
2. 在应用设置中补全 **应用名称**、**应用简介**、**图标 URL**
3. 启动后飞牛桌面会出现 LX Music 图标，点击直达 http://飞牛IP:3210

---

## 网络模式说明

项目默认使用 **host 网络模式**：

```yaml
network_mode: host
```

容器共享宿主机网络栈，可规避部分飞牛 / 软路由的 DNS 污染问题。此时**不需要**做端口映射，访问端口就是 `HTTP_PORT`（默认 `3210`）。

如果你的环境不支持 host 模式（个别旧版 Docker Desktop、受限网络环境），改回 bridge 模式：

1. 删除 `docker-compose.yml` 中的 `network_mode: host` 及其上方注释
2. 在 `environment` 下方添加端口映射：

   ```yaml
   ports:
     - "${HTTP_PORT:-3210}:3210"
   ```

3. 重建启动：`docker compose up -d`

---

## 升级与回退

```bash
cd /vol1/1000/docker/lx-music-docker

# 1. 更新代码
git pull                       # 或直接用新版 zip 覆盖（保留 data/ 目录）

# 2. 重新构建并重启
docker compose up -d --build
```

`data/` 不在版本控制中，升级不会丢失歌单、下载记录和音乐文件。

**回退**：把代码切回上一个版本 tag 后重复上面两条命令即可。

---

## 卸载

```bash
cd /vol1/1000/docker/lx-music-docker

docker compose down            # 停止并删除容器
rm -rf ./data                  # 删除数据（确认不再需要时才执行）
```

---

## 容器内路径对照

| 容器内路径 | 内容 | 说明 |
| --- | --- | --- |
| `/app/data` | 数据根目录 | 包含 `db.sqlite`、`config.json` |
| `/app/data/sources` | 音源脚本 | 可在 Web UI 添加，也可直接放 `.js` 文件后重载 |
| `/app/data/music` | 下载的音乐 | 按 `A-Z` / 拼音首字母自动归档 |
