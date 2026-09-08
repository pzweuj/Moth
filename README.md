# Moth

Moth 是一个面向单用户的、Filesystem First 自托管 PWA 阅读器。它只承诺
EPUB、TXT、CBZ 和经典无 DRM MOBI 四种输入格式：书库原文件保持不动，服务端
建立 SQLite 索引，浏览器通过认证 API 在线阅读并同步进度。

## 产品边界

- Library → Directory → Publication 完全映射配置的文件系统目录；Web UI 不创建、移动、改名或整理文件。
- 支持单用户认证、目录浏览、多 Library、标题/作者/文件名搜索、格式筛选、继续阅读、最近添加和阅读设置。
- EPUB 直接通过只读源文件的 HTTP Range 读取；TXT 使用服务端编码检测、章节索引和 UTF-8 byte range；CBZ 按页从 ZIP 解压；MOBI 首次打开时在服务端转换为最小 EPUB3 并缓存。
- PWA 只预缓存应用外壳和构建资源。API、书籍文件、章节和漫画页面不会进入 Cache Storage 或 IndexedDB；断网时只能打开外壳，阅读需要连接服务器。
- 阅读设置只写入浏览器 `localStorage`；服务端进度使用 EPUB CFI、TXT 章节/字符偏移或 CBZ 页索引保存。

不支持 AZW3/KF8、PDF、FB2、上传、OPDS、多用户、在线书源、元数据抓取、离线书架、文件整理或推荐功能。损坏、DRM 或超出经典 MOBI 范围的文件会显示“请转换为 EPUB”的错误。

## 配置书库

`MOTH_CONFIG_FILE` 是 Library 的唯一来源，内容为 TOML：

```toml
[[libraries]]
key = "novels"
name = "小说"
path = "/books/novels"

[[libraries]]
key = "comics"
name = "漫画"
path = "/books/comics"
```

`key`、`name` 和规范化后的 `path` 必须非空且唯一；存在的路径必须是目录。配置文件缺失或无效会阻止启动。未设置 `MOTH_CONFIG_FILE` 时，服务端将 `MOTH_BOOKS_DIR` 映射为 `key=default`、`name=书库` 的单 Library，以便本地快速运行。

书库应以只读方式挂载。Moth 只向 `MOTH_DATA_DIR` 写入数据库、封面和派生缓存：

```text
data/
├── moth.db
├── covers/<content-version>.jpg
├── txt/<content-version>/<encoding>/book.utf8
└── mobi/<content-version>/<converter-version>/book.epub
```

当前 schema 不迁移旧数据库。升级到 V0.2 前请先备份并删除 `moth.db`、`moth.db-wal` 和 `moth.db-shm`，再启动服务重新扫描。

## 本地开发

要求 Rust 1.97.1、Node.js 22 LTS 和 pnpm 11.19.0。

```powershell
$env:MOTH_DATA_DIR = ".local/data"
$env:MOTH_BOOKS_DIR = ".local/books"
$env:MOTH_WEB_DIR = "web/dist"
cargo run -p moth-server
```

另一个终端启动前端：

```powershell
pnpm install
pnpm --dir web dev
```

Vite 默认运行在 <http://127.0.0.1:5373>，并把 `/api` 代理到 Axum 的
`127.0.0.1:8080`。首次访问 `/setup` 创建单用户账户；密码只通过 HttpOnly
session cookie 维持，不写入浏览器存储。

可用示例书：

```powershell
cargo run -p moth-server --example make_books -- .local/books
```

服务启动后会后台增量扫描；首页的“重新扫描”只扫描对应 Library。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MOTH_BIND_ADDR` | `0.0.0.0:8080` | 监听地址。 |
| `MOTH_DATA_DIR` | `/data` | 可写数据目录，包含 `moth.db`。 |
| `MOTH_CONFIG_FILE` | 未设置 | TOML Library 配置；设置后不再读取 `MOTH_BOOKS_DIR`。 |
| `MOTH_BOOKS_DIR` | `/books` | 未设置 `MOTH_CONFIG_FILE` 时的单书库回退路径。 |
| `MOTH_WEB_DIR` | `web/dist` | 生产前端静态文件目录。 |
| `MOTH_COOKIE_SECURE` | `false` | HTTPS 反向代理后设为 `true`。 |
| `MOTH_SESSION_TTL_DAYS` | `30` | 正数 session 有效期。 |
| `MOTH_LOG` | `info` | tracing 过滤器。 |

## Docker Compose

仓库提供了双 Library 的只读挂载示例。先编辑 `config/libraries.toml`，然后准备对应目录：

```powershell
New-Item -ItemType Directory -Force data, config, books/novels, books/comics
docker compose up --build -d
docker compose ps
```

Compose 将配置挂载到 `/config/libraries.toml:ro`，并将每个 Library 根目录挂载到
`/books/novels:ro`、`/books/comics:ro`。可通过 `.env` 中的
`MOTH_CONFIG_PATH`、`MOTH_NOVELS_PATH` 和 `MOTH_COMICS_PATH` 指向宿主机路径。
`/data` 保持可写，容器以 UID/GID `10001` 的非 root 用户运行。

```powershell
docker compose config
docker compose build
```

若使用反向代理终止 TLS，设置 `MOTH_COOKIE_SECURE=true` 并保持同源访问。备份时先停止服务，再复制整个 `data` 目录。

## API 概览

所有 `/api/v1` 业务端点都需要 session cookie：

| 端点 | 用途 |
| --- | --- |
| `GET /home` | 继续阅读、最近添加、小说、漫画。 |
| `GET /libraries` | 配置书库及数量。 |
| `GET /libraries/{key}/browse?path=...` | 面包屑、直接子目录和当前目录 Publication。 |
| `GET /publications?q=&library=&format=&author=&sort=` | 全局搜索和筛选。 |
| `GET /publications/{id}` | Publication 元数据、TXT 章节或 CBZ 页索引。 |
| `GET /publications/{id}/cover`、`/file`、`/chapters/{index}`、`/pages/{index}` | 阅读资源；EPUB/MOBI 文件支持 Range、ETag 和源版本检查。 |
| `GET/POST /publications/{id}/conversion` | 查询或启动 MOBI→EPUB 转换。 |
| `GET/PUT /publications/{id}/progress` | 读取或覆盖服务端进度。 |
| `POST /libraries/{key}/scan`、`GET .../scan/status` | 手动扫描及状态。 |

响应同时给出 `source_format` 和 `reader_format`；MOBI 的 reader format 为 EPUB。

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

Docker、真实 Edge、Android Chrome、iPhone Safari/PWA 和可信 HTTPS 需要在相应环境执行；本地未执行时不得标记为通过。当前验收矩阵见 [`docs/v0.2-acceptance.md`](docs/v0.2-acceptance.md)，产品范围以 [`CORE.md`](CORE.md) 为最高优先级。

Moth 使用 Apache-2.0 许可证。
