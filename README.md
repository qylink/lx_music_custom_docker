# LX Music Docker · 洛雪音乐 · 本地 / NAS 部署版

> 原项目 [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 是 Electron 桌面应用，不适合在服务器 / NAS 上直接使用。
> 本项目把它"解压为云端服务"——保留三个核心能力：**添加自定义音源**、**导入网易云歌单**、**批量下载**，
> 全部通过浏览器操作，无需桌面环境。纯本地运行，不依赖任何外部 CDN。

| 能力 | 说明 |
| --- | --- |
| 添加音源 | 支持 LX Music 兼容脚本（CommonJS `module.exports`），可粘贴脚本、从 URL 拉取、上传 .js 文件，并启用/禁用/重载/查看源码/删除 |
| 网易云歌单 | 通过官方 `api/v6/playlist/detail` 解析公开歌单（无需登录），粘贴歌单链接/ID 即可导入，带实时进度 |
| 批量下载 | 队列化下载，支持自定义音质、失败自动换源/降质重试、实时进度、自动写入 A-Z/拼音分类目录 |
| 文件浏览 | 内置目录树浏览，方便把下载目录分享给其他 App |

---

## 1. 快速开始（新手看这里）

### 方式一：Docker 部署（推荐，3 分钟）

**前置**：安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)（Windows / macOS）或 Docker Engine + Compose（Linux）。

```bash
# 1. 获取代码（二选一）
git clone <本项目仓库地址> lx-music-docker
# 或：下载项目 zip 解压，进入解压目录

# 2. 一键构建并启动
docker compose up -d --build

# 3. 打开浏览器
#    http://localhost:3210
```

看到容器状态为 `healthy`（`docker compose ps`）即部署成功。

> **说明**
> - `--build` 会用项目里的 `Dockerfile` 本地构建镜像，无需任何镜像仓库账号；
> - 若你已配置私有/局域网镜像仓库，在 `.env` 里设置 `LX_IMAGE=你的镜像` 即可跳过构建（`cp .env.example .env` 后修改）；
> - 数据保存在 `./data`（数据库、音源）与 `./data/music`（下载的音乐），删除容器不影响数据。

### 方式二：不装 Docker，直接跑 Node

**前置**：[Node.js 18+](https://nodejs.org/)（推荐 20/22 LTS）。

```bash
cd lx-music-docker
npm install     # 首次安装依赖（better-sqlite3 有预编译包，一般无需编译环境）
npm start       # 或 node src/server.js
```

打开 http://localhost:3210 。

> Windows 下若 `npm install` 在 `better-sqlite3` 处报编译错误：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选"C++ 桌面开发"）后重试，或改用上面的 Docker 方式。

### 方式三：NAS / 飞牛 OS 部署

见 **[DEPLOY-fnos.md](./DEPLOY-fnos.md)**（含飞牛 Docker UI 图形部署、SSH 命令行、自建应用三种方式，以及 host 网络模式说明）。

---

## 2. 首次使用流程

### 2.1 添加音源

打开 **音源管理** 标签页，有四种方式：

1. **内置音源**：开箱即用（网易云官方风格音源等），按需启用/禁用；
2. **粘贴脚本**：把洛雪格式的音源脚本（`module.exports = { info, musicSearch, musicUrl, ... }`）贴进文本框，填文件名后点「添加」；
3. **远程拉取**：把脚本的原始 URL 填进去（兼容 jsDelivr / GitHub raw），系统下载并保存；
4. **直接放目录**：把 `.js` 文件复制到 `data/sources/`，重启容器或点「重新加载」。

> ⚠️ **安全提示**：添加的脚本运行在 Node.js vm 沙箱中，允许的依赖仅限 `axios / crypto / https / http / url / querystring / zlib`。
> 请只使用可信来源的洛雪音源脚本（例如 [lyswhut/lx-music-script](https://github.com/lyswhut/lx-music-script)），
> 千万不要添加来路不明的脚本——沙箱不是绝对隔离，恶意脚本仍可能发起网络请求。

### 2.2 导入网易云歌单

打开 **歌单导入** 标签页：

1. 粘贴歌单链接或直接填 ID，例如：
   ```
   https://music.163.com/playlist?id=24381609
   ```
2. 点「导入」，实时进度条会显示解析 → 保存进度；
3. 导入完成后选择某个音源点「查找音源」，每首歌旁会显示匹配结果；
4. 勾选要下载的歌曲 → 「批量下载所选项」，按所选音质入队。

> 解析**公开歌单**不需要登录。要解析"我创建/收藏的私享歌单"或下载 VIP/高音质歌曲，
> 把浏览器 Cookie 里的 `MUSIC_U` 填到 `.env` 的 `NETEASE_MUSIC_U` 后重启（支持多个 token 用 `||` 分隔轮换）。

**Cookie 获取方法**：浏览器登录 [music.163.com](https://music.163.com) → F12 开发者工具 → Application → Cookies → 复制 `MUSIC_U` 的值。
> ⚠️ `MUSIC_U` 等同于账号凭据，不要分享给他人或提交到任何仓库；有极小的风控风险，建议用小号。

### 2.3 批量下载与任务管理

打开 **下载管理** 标签页：

- 实时显示队列进度（SSE 推送），含速度 / 剩余时间；
- 单条任务可**重试**、**手动换音源**（下拉选择）、删除；「全部重试」会跳过无版权等永久失败项；
- 下载失败自动按 320→192→128 降质重试，再自动切换其他已启用音源；
- 完成后自动写入元数据并按 `A-Z / #` 目录归档：

```
data/music/
├── A/
│   └── Artist Name/
│       └── Album Name/
│           └── Song Name.mp3
└── Z/
    └── 周杰伦/
        └── 范特西/
            └── 安静.mp3
```

中文按拼音首字母归档，数字与符号归入 `#`。

### 2.4 浏览与分享已下载文件

**下载文件** 标签页可树形浏览 `data/music/`。把该目录通过 NAS 的 SMB / WebDAV 共享，
或挂载到媒体库（Plex / Jellyfin / 飞牛相册）即可播放。

---

## 3. 配置项（环境变量）

复制 `.env.example` 为 `.env` 修改，或直接改 `docker-compose.yml` 的 `environment`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HTTP_PORT` | `3210` | Web 端口（compose 层；host 网络模式下即宿主端口） |
| `PORT` / `HOST` | `3210` / `0.0.0.0` | 容器内监听端口 / 地址 |
| `LX_IMAGE` | `qylinkdc/lx_music_custom_docker:1.5.0` | compose 层镜像地址，私有仓库在此覆盖 |
| `APP_NAME` | `lx-music-docker` | 容器名 |
| `TZ` | `Asia/Shanghai` | 时区（影响下载时间戳与归档排序） |
| `DATA_BIND` / `MUSIC_BIND` / `SOURCES_BIND` | `./data` 等 | compose 层挂载路径（NAS 上常改为 `/vol1/...` 绝对路径） |
| `DATA_DIR` | `./data` | 数据根目录（数据库 / 配置） |
| `DOWNLOAD_QUALITY` | `320` | 默认音质（`128`/`192`/`320`/`flac`） |
| `DOWNLOAD_CONCURRENCY` | `3` | 下载并发任务数 |
| `DOWNLOAD_TIMEOUT` | `90000` | 单任务超时（毫秒） |
| `DOWNLOAD_JITTER_MIN_MS` / `MAX_MS` | `200` / `800` | 每首歌下载前随机延迟区间，防突发触发限流 |
| `MAX_RETRIES_PER_SOURCE` | `2` | 同一源内瞬时错误重试次数 |
| `MAX_ATTEMPTS_PER_SOURCE` | `4` | 切换备选源前单源最大尝试次数（含降质） |
| `SOURCE_CALL_TIMEOUT` | `15000` | 调用音源脚本方法超时（毫秒） |
| `NETEASE_MUSIC_U` | （空）| 网易云 Cookie `MUSIC_U`，支持多个用 `\|\|` 分隔轮换；解析私享歌单 + VIP/320k/flac |
| `NETEASE_USER_AGENT` | Win Chrome | 解析歌单 UA，被风控时可调整 |
| `LOG_LEVEL` | `info` | 日志级别（`debug`/`info`/`warn`/`error`） |

---

## 4. 常见问题（FAQ）

**Q：打开 http://localhost:3210 提示无法访问？**
1. `docker compose ps` 看状态：`starting` 属正常（健康检查有 30 秒启动期），等 `healthy`；
2. 端口被占用 → 改 `.env` 的 `HTTP_PORT=3211` 后 `docker compose up -d`；
3. 旧版 Docker Desktop（< 4.34）host 网络模式下宿主访问不到 → 按 [DEPLOY-fnos.md](./DEPLOY-fnos.md) 的「网络说明」切回 bridge + `ports` 映射；
4. 查日志：`docker compose logs -f`，看到 `Listening on 0.0.0.0:3210` 即服务已起。

**Q：顶部横幅提示"MUSIC_U 未配置"？**
只影响 VIP / 付费 / 320k 以上歌曲，公开 128k 歌曲不受影响。按 2.2 节配置 `NETEASE_MUSIC_U` 即可。

**Q：歌单导入没有进度 / 卡住？**
刷新页面重试；导入大歌单（1000+ 首）需要十几秒。仍异常时看 `docker compose logs -f` 里 `[import]` 相关输出。

**Q：下载失败 / 失败率高？**
1. 失败任务行有**音源下拉框**，手动换源后点重试；
2. 「全部重试」自动跳过无版权等永久失败项；
3. 音源本身失效 → 到音源管理页更新脚本（URL 重拉取）或换源；
4. 频繁失败触发限流 → 调大 `DOWNLOAD_JITTER_*`、调小 `DOWNLOAD_CONCURRENCY`。

**Q：添加的音源不显示 / 报错？**
脚本需兼容洛雪格式（见 6.2 契约）；`require` 的模块仅限沙箱白名单；到源码查看页看报错信息。

**Q：数据会丢吗？升级怎么办？**
数据都在 `./data`（compose 升级 / 容器重建不删除）。升级：覆盖代码后 `docker compose up -d --build`。

**Q：完全离线的内网环境能用吗？**
能。项目零外部 CDN 依赖（字体/图标全部本地或系统字体），镜像与依赖在构建时已打包。只有"远程拉取音源 URL"与网易云在线解析需要外网。

---

## 5. 给开发者

### 5.1 本地开发

```bash
npm install
npm run dev     # node --watch，改代码自动重启
npm test        # 单元测试
```

### 5.2 版本发布（维护者）

改代码后需要同步两处版本号，再构建部署：

1. `package.json` → `version`（可用 `node scripts/deploy.js` 自动 bump + 构建 + 部署，该脚本属本地工具不入库）；
2. `docker-compose.yml` → `image:` 默认 tag 与之相同。

### 5.3 音源脚本契约（兼容洛雪）

```js
module.exports = {
  info: { name, platform, author, description, type: 'music' },
  async musicSearch({ key, page, limit }) { return { total, pages, list: [{ id, name, singer, album, source, interval }] } },
  async musicUrl(songInfo, quality) { return { url, br } },
  async lyric(songInfo) { return { lyric, tlyric } },
  async pic(songInfo) { return { url } },
};
```

### 5.4 API 接口（部分）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET`  | `/api/health` | 健康检查 |
| `GET`  | `/api/info` | 系统信息 |
| `GET`  | `/api/sources` | 列出音源（默认仅父音源；`?all=1` 含子音源） |
| `POST` | `/api/sources/add` | 添加音源（body: `{ fileName, content }`） |
| `POST` | `/api/sources/add-url` | 远程拉取并添加 |
| `POST` | `/api/sources/toggle-all` | 一键启用/禁用全部 `{ enabled }` |
| `POST` | `/api/sources/:id/toggle` | 启/停（`{ enabled, scope: 'script' }` 级联子音源） |
| `POST` | `/api/sources/:id/reload` | 重载 |
| `POST` | `/api/sources/:id/refresh` | 从 URL 重新拉取 |
| `GET`  | `/api/sources/:id/file` | 查看脚本源码 |
| `DELETE`| `/api/sources/:id` | 删除 |
| `POST` | `/api/playlist/import` | 导入网易云歌单 `{ url }` |
| `GET`  | `/api/playlist/list` | 已导入歌单 |
| `GET`  | `/api/music/search?sourceId=&key=` | 关键词搜索（指定音源） |
| `POST` | `/api/music/find` | 跨源搜索 `{ name, singer }` |
| `POST` | `/api/download/enqueue` | 入队批量下载 `{ sourceId, songs:[{ name, artists, album }], quality }` |
| `GET`  | `/api/download/list` | 列出任务 |
| `GET`  | `/api/download/task/:id` | 单任务最新状态 |
| `GET`  | `/api/download/stats` | 队列统计 |
| `POST` | `/api/download/retry/:id` | 重试（body 可选 `{ sourceId }` 手动换源） |
| `POST` | `/api/download/retry-all` | 重试所有失败项 |
| `GET`  | `/api/download/stream` | SSE 实时进度 |

### 5.5 项目结构

```
lx-music-docker/
├── Dockerfile / docker-compose.yml
├── package.json
├── src/
│   ├── server.js                 # Fastify 入口
│   ├── config/                   # 配置
│   ├── constants.js              # 音质优先级等共享常量
│   ├── db/                       # better-sqlite3 数据库
│   ├── routes/                   # HTTP 路由
│   ├── services/
│   │   ├── netease.js            # 网易云歌单解析
│   │   ├── downloader.js         # 下载器 + 文件命名
│   │   ├── queue.js              # 队列消费者（换源/降质/重试）
│   │   └── quality-utils.js      # 错误分类 / 音质降级纯函数
│   ├── sources/
│   │   ├── sandbox.js            # vm 沙箱
│   │   └── sourceManager.js      # 音源注册表
│   └── utils/                    # 日志/响应
├── public/                       # Web UI（无构建步骤）
├── script/                       # 随镜像预置的音源（启动时拷入 data/sources）
├── builtin-sources/              # 内置音源
└── data/                         # 运行时数据（音源/音乐/数据库，不入库）
```

---

## 6. 协议

- **本项目**：[Apache-2.0](./LICENSE)
- **上游项目**：[lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)（Apache-2.0）、[lyswhut/lx-music-source](https://github.com/lyswhut/lx-music-source)（MIT）
- **音源脚本**：你安装的音源脚本归各自作者所有，使用前请遵守原作者的服务条款与所在地区法律法规；
- **下载的音乐**：请于 24 小时内删除仅供试听的副本，尊重版权，支持正版。

> 仅供学习与个人使用，严禁商业用途。
