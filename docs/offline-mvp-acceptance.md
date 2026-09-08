# Moth 首版发布验收记录

日期：2026-09-08

基线提交：`4d7f8d0`
验收范围：在线优先、单用户、自托管阅读器的首版发布门槛。

Moth 保持 `/api/v1` 接口、单用户模型和按较大百分比解决同步冲突的规则。原书库只读，应用只缓存实际访问过的章节、漫画页面和必要资源；不提供整本下载、多用户、PDF 或生产测试后门。EPUB、TXT、CBZ 和无 DRM MOBI 是本版承诺格式；AZW3/KF8 仍标记为实验性，失败时建议转换为 EPUB。

## 验收环境

| 项目 | 环境 |
| --- | --- |
| 操作系统 | Windows 工作站（本地验收） |
| Rust/Cargo | rustc/cargo 1.97.1 |
| Node.js | v24.19.0（CI 使用 Node 22） |
| pnpm | 11.19.0 |
| Playwright | 1.63.0；Chromium、WebKit 已安装 |
| Docker | 本机未安装，容器项转 CI/Docker 主机 |

浏览器测试由 Axum 托管生产构建，使用每个测试独立的临时数据目录和样书目录。断网使用 Playwright 的网络离线状态；测试失败时保留 Playwright 截图、trace、视频和服务端日志。

## 本轮实现

- IndexedDB 使用 `fake-indexeddb` 覆盖真实事务：进度和待同步队列原子写入、网络挂起期间继续保存新位置、旧响应不覆盖新位置、联网/前台/重新登录重试、版本/编码/服务器实例/账号隔离、内容清理保留进度和队列、退出清理冻结在途写入、配额异常显示失败状态。
- Playwright 加入 Chromium 和 WebKit 项目，生产构建由 Axum 托管；夹具包含长篇多页 TXT、GBK TXT、嵌套目录和 CSS/图片的 EPUB、八页 CBZ、有效无封面 EPUB、损坏 EPUB、实验性 AZW3 文件和真实 MOBI。
- 阅读器在离线时优先使用已提交的章节缓存；WebKit 通过 `srcdoc` 恢复已缓存 EPUB/MOBI 章节，未缓存单元继续给出联网提示。Service Worker 更新等待用户刷新。
- 服务端保持内容版本快照和 Range/ETag 一致性；阅读前清理 EPUB/MOBI 内容和 CSS 的活动内容，书架对无封面显示格式占位符，对损坏文件显示可恢复状态。

## 自动化结果

| 检查 | 结果 | 证据/备注 |
| --- | --- | --- |
| `cargo fmt --all --check` | PASS | Rust 1.97.1 |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS | 无警告 |
| `cargo test --workspace` | PASS | 51 项：17 格式单元、1 项真实 MOBI、21 服务端单元、12 项 API 集成 |
| `cargo build --release --workspace` | PASS | release 二进制构建成功 |
| `pnpm --dir web lint` | PASS | 0 错误；5 项 Fast Refresh 警告，低优先级记录 |
| `pnpm --dir web test --run` | PASS | 14 个文件、62 项通过 |
| `pnpm --dir web build` | PASS | 主包 543.68 kB；存在大于 500 kB 的低优先级警告 |
| Playwright Chromium | PASS | 9/9，34.0 秒 |
| Playwright WebKit | PASS | 9/9，1.2 分钟 |

浏览器闭环覆盖初始化、登录、扫描、栏目移动、无封面占位符、损坏书提示、EPUB 嵌套目录和安全清理、TXT/EPUB/CBZ/MOBI 阅读、翻页、跳章、重新打开恢复位置、断网刷新、未缓存单元提示、联网同步、清理内容保留进度、TXT 编码切换、重扫后内容版本变化、主题/语言、字号、漫画缩放、触控翻页和 Service Worker 更新。

## 格式样本

`crates/moth-format/tests/fixtures/alice.mobi` 来自 [Project Gutenberg ebook 11](https://www.gutenberg.org/ebooks/11)，下载地址为 [Older Kindles / MOBI](https://www.gutenberg.org/ebooks/11.kindle.images)。目录声明美国公有领域，文件无 DRM，大小 241000 bytes，SHA-256 为：

`29448cd44f3e6d3db391c6aefc438f53283142d9e8a41ef439718a5d84f36240`

Rust 测试确认标题、章节和正文可解析；Chromium/WebKit 进一步确认 Foliate 实际渲染、目录导航、缓存和离线进度恢复。该样本只能证明 MOBI，不代表 AZW3/KF8 兼容性。来源、许可和预期内容记录在 [`crates/moth-format/tests/fixtures/README.md`](../crates/moth-format/tests/fixtures/README.md)。

## 待验收与发布限制

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Docker 构建和运行 | PENDING | 本机无 Docker；CI 已加入 `docker compose config`、构建和 `scripts/container-smoke.py`，需在 Docker 主机确认健康检查、setup→login→重启→logout、数据持久化、非 root、`/books` 只读、`/data` 可写和 SIGTERM。 |
| 桌面 Edge | PENDING | 本轮自动化使用 Chromium 和 WebKit；Edge 需单独运行核心流程。 |
| Android Chrome、iPhone Safari、主屏幕 PWA | PENDING | 需要真实设备、可信 HTTPS；断网冷启动、后台恢复、横竖屏、触控和缓存容量尚未取得证据。 |
| 真实配额不足 | PENDING | 已有模拟配额异常的 Vitest 回归；真实浏览器配额反馈仍需设备验收。 |
| AZW3/KF8 | EXPERIMENTAL | 不作为首版完整兼容承诺；解析或渲染失败时提示转换为 EPUB。 |

因此当前自动化门槛已闭环，但在 Docker、Edge、移动设备和真实配额证据补齐前，不标记为最终首版发布；这些项目不能由自动化结果代替。

## 重跑命令

```powershell
$env:CARGO_TARGET_DIR = "target-e2e"
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release --workspace
pnpm --dir web lint
pnpm --dir web test --run
pnpm --dir web build
pnpm --dir web test:e2e
```

CI 工作流保留 Rust/前端检查，并运行 Chromium/WebKit 浏览器任务和容器冒烟任务；失败产物上传 14 天。
