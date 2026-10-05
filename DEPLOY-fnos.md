# ============================================================
# 飞牛 OS（FnOS / NAS）部署指南
# ============================================================
# 三种方式，任选其一：

# ---- 方式 1：飞牛 Docker UI（图形界面，最省事）----
#   1. 把整个项目压缩包（lx-music-docker.zip）上传到飞牛共享目录，比如：
#        /vol1/1000/docker/lx-music-docker/
#      然后解压，确保 docker-compose.yml 与 .env 在该目录下。
#   2. 进入飞牛桌面 → Docker → 项目管理 → 新建 → 本地创建
#   3. 项目名称：lx-music-docker
#      路径：    /vol1/1000/docker/lx-music-docker
#   4. 创建后稍等几秒，状态会从 Created → Running
#   5. 浏览器打开 http://飞牛IP:3210
#      ※ 如飞牛开启了 HTTPS 反代，第一次打开要放行 3210 端口

# ---- 方式 2：SSH 命令行（最直接）----
#   ssh <你的用户名>@<飞牛IP>
#   cd /vol1/1000/docker
#   git clone <本项目仓库地址> lx-music-docker   # 或：上传 zip 解压
#   cd lx-music-docker
#   cp .env.example .env
#   # 可选：编辑 .env 把 MUSIC_BIND 改成 /vol1/1000/music/lx
#   vim .env
#   docker compose up -d --build    # 首次本地构建镜像
#   docker compose logs -f          # 看到 Listening on 0.0.0.0:3210 即成功
#
#   ※ 已有构建好的镜像时可跳过 --build；私有/局域网镜像仓库在 .env 里设 LX_IMAGE。

# ---- 方式 3：飞牛 "自建应用"（Docker → 应用 → 导入自定义 compose）----
#   飞牛 0.8+ 支持把任意 compose 项目当作一个应用显示：
#     - 创建项目时填好 "应用名称"、"应用简介"、"图标 url"
#     - 启动后桌面会显示 LX Music 图标，点开直达 http://飞牛IP:3210

# ============================================================
# 网络说明（重要）
# ============================================================
#   本 compose 默认 network_mode: host —— 容器共享宿主网络栈，
#   规避部分飞牛/软路由的 DNS 污染问题，端口即 HTTP_PORT（默认 3210）。
#   如果你的环境用不了 host 模式（个别 Docker Desktop / 严格环境）：
#     1) 删除 docker-compose.yml 中的 `network_mode: host` 与注释行
#     2) 在 environment 下方加：ports: ["${HTTP_PORT:-3210}:3210"]
#   ※ 飞牛 Docker UI 用 host 模式时无需做端口映射。

# ============================================================
# 升级 / 回退
# ============================================================
#   cd /vol1/1000/docker/lx-music-docker
#   git pull                       # 或覆盖为新版本 zip
#   docker compose up -d --build   # 重新构建并重启
#
#   数据卷 ./data 不在版本控制中，升级不会丢失。

# ============================================================
# 卸载
# ============================================================
#   cd /vol1/1000/docker/lx-music-docker
#   docker compose down             # 停服务
#   rm -rf ./data                   # 删除数据（确认不需要再删）

# ============================================================
# 容器内默认路径（无需修改）
# ============================================================
#   /app/data          数据根（含 db.sqlite / config.json）
#   /app/data/sources  音源脚本（可在 Web UI 添加，也可直接放 .js 文件）
#   /app/data/music    下载的音乐（按 A-Z / 拼音自动归档）
