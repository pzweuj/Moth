# Moth

Moth 是一个单用户、filesystem-first 自托管 PWA 阅读器。它只读取一个书库根目录中的 EPUB、TXT、CBZ 和经典无 DRM MOBI；原文件保持不动，服务器只在数据目录维护索引、派生缓存和阅读进度。

## 产品边界

- `MOTH_BOOKS_DIR` 是唯一书库根目录，子目录就是分类。
- 要把一级书架收进首页的“更多书架”，在 `MOTH_BOOKS_DIR/<书架>/hide` 放置一个普通文件（空文件即可，内容不会读取）；只检查一级书架，根目录或系列目录中的同名文件不生效。刷新首页即可生效。隐藏书架仍可从“更多书架”进入，里面的书不会出现在“继续阅读”。
- 首页显示继续阅读和按“分类/系列/作品”层级组织的目录预览；已登录的主页、目录、书架和系列页支持搜索书架、系列和书籍名称，不提供作者筛选、系列管理或文件整理。
- EPUB 使用 HTTP Range 和 CFI；TXT 使用编码检测、中文章节索引和 UTF-16 字符定位；CBZ 按页解压；MOBI 首次打开时转成 EPUB 缓存。
- PWA 从安卓桌面启动时请求全屏显示，并通过 `viewport-fit=cover` 适配刘海、挖孔屏和底部手势区域；系统手势或不支持全屏的浏览器仍可能临时显示系统栏。更新后的 manifest 可能要等 Service Worker 更新，已安装应用仍可重新安装后生效。阅读资源和进度请求需要连接服务器。
- 设置保存在浏览器 `localStorage`；登录会话使用 HttpOnly cookie。

不支持离线书籍、多用户、上传、OPDS、Kobo/KOReader、在线书源、元数据抓取、文件整理、推荐、AZW3/KF8、PDF 或 FB2。

## 配置

```powershell
$env:MOTH_DATA_DIR = ".local/data"
$env:MOTH_BOOKS_DIR = ".local/books"
$env:MOTH_WEB_DIR = "web/dist"
cargo run -p moth-server
```

生产镜像内置以下配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MOTH_BIND_ADDR` | `0.0.0.0:8080` | 监听地址 |
| `MOTH_DATA_DIR` | `/data` | SQLite、封面、TXT 和 MOBI 缓存目录 |
| `MOTH_BOOKS_DIR` | `/books` | 只读书库根目录 |
| `MOTH_WEB_DIR` | `/app/web` | 前端静态文件目录 |
| `MOTH_COOKIE_SECURE` | `false` | HTTPS 反向代理后设为 `true` |
| `MOTH_SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `MOTH_LOG` | `info` | tracing 过滤器 |
| `MALLOC_ARENA_MAX` | `2`（镜像默认） | glibc 分配区上限；可在容器运行时覆盖 |

首次访问 `/setup` 创建单用户账户。升级到不兼容 schema 时，服务会拒绝启动；请先备份并删除 `moth.db`、`moth.db-wal`、`moth.db-shm`，然后重新扫描。

登录在单个服务实例内全局限速：至少间隔 1 秒，连续未成功尝试从第 5 次起指数退避，最长 60 秒。限流返回 `429` 和 `Retry-After`；成功登录或空闲 15 分钟后重置退避。限流状态保存在内存中，重启后重置，已有会话不受影响。

## 本地开发

要求 Rust 1.97.1、Node.js 22 LTS 和 pnpm 11.19.0。

```powershell
$env:MOTH_DATA_DIR = ".local/data"
$env:MOTH_BOOKS_DIR = ".local/books"
$env:MOTH_WEB_DIR = "web/dist"
cargo run -p moth-server --example make_books -- .local/books
```

另一个终端运行 `pnpm install`、`pnpm --dir web dev`。Vite 默认在 <http://127.0.0.1:5373>，并把 `/api` 代理到 Axum 的 `127.0.0.1:8080`。

## Docker Compose

Compose 默认使用 `ghcr.io/pzweuj/moth:latest`。私有镜像需先登录 GHCR。

准备目录并启动：

```powershell
New-Item -ItemType Directory -Force data, books
docker compose pull
docker compose up -d
docker compose ps
```

Compose 将 `./data` 挂载到 `/data`，将 `${MOTH_BOOKS_PATH:-./books}` 以只读方式挂载到 `/books`。Compose 明确以 root 用户启动容器，避免宿主机 bind mount 的 UID/GID 不匹配导致 SQLite 无法创建数据库。要固定版本，修改 `image`，例如 `ghcr.io/pzweuj/moth:v0.0.1`。

## API 概览

所有 `/api/v1` 业务端点都需要 session cookie：

| 端点 | 用途 |
| --- | --- |
| `GET /home` | 继续阅读、分类/系列目录预览和折叠的隐藏书架入口 |
| `GET /browse?path=...` | 面包屑、子目录（含直属系列/书籍统计）和当前目录的书 |
| `GET /search?q=...&include_hidden=false&kind=all&offset=0&limit=20` | 全书库搜索书架、系列和书籍名称；每组返回分页结果和总数 |
| `POST /scan`、`GET /scan/status` | 启动扫描和读取全局扫描状态（包括发现阶段） |
| `GET /publications/{id}` | Publication 元数据、TXT 章节或 CBZ 页索引 |
| `GET /publications/{id}/cover`、`/file`、`/chapters/{idx}`、`/pages/{idx}`、`/pages/{idx}/thumbnail` | 阅读资源 |
| `GET/POST /publications/{id}/conversion` | 查询或启动 MOBI→EPUB 转换 |
| `GET/PUT /publications/{id}/progress` | 读取或保存服务端进度 |

## 检查

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test --workspace --offline
pnpm --dir web lint
pnpm --dir web test --run
pnpm --dir web build
pnpm --dir web test:e2e
docker compose config
docker compose build
python scripts/container-smoke.py
```

Docker、真实移动设备和可信 HTTPS 需要在相应环境单独验收。产品边界以 [`CORE.md`](CORE.md) 为准。
