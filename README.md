# Moth

Moth 是一个单用户、filesystem-first 自托管 PWA 阅读器。它只读取一个书库根目录中的 EPUB、TXT、CBZ 和经典无 DRM MOBI；原文件保持不动，服务器只在数据目录维护索引、派生缓存和阅读进度。

## 产品边界

- `MOTH_BOOKS_DIR` 是唯一书库根目录，子目录就是分类。
- 首页只有继续阅读、最近添加和目录；没有搜索、作者筛选、系列管理或文件整理。
- EPUB 使用 HTTP Range 和 CFI；TXT 使用编码检测、中文章节索引和 UTF-16 字符定位；CBZ 按页解压；MOBI 首次打开时转成 EPUB 缓存。
- PWA 只缓存应用外壳和构建资源。阅读资源和进度请求需要连接服务器。
- 设置保存在浏览器 `localStorage`；登录会话使用 HttpOnly cookie。

不支持离线书籍、多用户、上传、OPDS、Kobo/KOReader、在线书源、元数据抓取、文件整理、推荐、AZW3/KF8、PDF 或 FB2。

## 配置

```powershell
$env:MOTH_DATA_DIR = ".local/data"
$env:MOTH_BOOKS_DIR = ".local/books"
$env:MOTH_WEB_DIR = "web/dist"
cargo run -p moth-server
```

生产环境的重要变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MOTH_BIND_ADDR` | `0.0.0.0:8080` | 监听地址 |
| `MOTH_DATA_DIR` | `/data` | SQLite、封面、TXT 和 MOBI 缓存目录 |
| `MOTH_BOOKS_DIR` | `/books` | 只读书库根目录 |
| `MOTH_WEB_DIR` | `web/dist` | 前端静态文件目录 |
| `MOTH_COOKIE_SECURE` | `false` | HTTPS 反向代理后设为 `true` |
| `MOTH_SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `MOTH_LOG` | `info` | tracing 过滤器 |

首次访问 `/setup` 创建单用户账户。升级到不兼容 schema 时，服务会拒绝启动；请先备份并删除 `moth.db`、`moth.db-wal`、`moth.db-shm`，然后重新扫描。

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

准备一个数据目录和只读书库目录：

```powershell
New-Item -ItemType Directory -Force data, books
docker compose up --build -d
docker compose ps
```

Compose 将宿主机的 `MOTH_BOOKS_PATH` 挂载到 `/books:ro`，将 `./data` 挂载到 `/data`。容器以 UID/GID `10001` 的非 root 用户运行。通过反向代理终止 TLS 时设置 `MOTH_COOKIE_SECURE=true`。

## API 概览

所有 `/api/v1` 业务端点都需要 session cookie：

| 端点 | 用途 |
| --- | --- |
| `GET /home` | 继续阅读和最近添加 |
| `GET /browse?path=...` | 面包屑、子目录和当前目录的书 |
| `POST /scan`、`GET /scan/status` | 启动扫描和读取全局扫描状态 |
| `GET /publications/{id}` | Publication 元数据、TXT 章节或 CBZ 页索引 |
| `GET /publications/{id}/cover`、`/file`、`/chapters/{idx}`、`/pages/{idx}` | 阅读资源 |
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
