# Moth 首版发布验收实施计划

目标：完成在线优先、自托管单用户阅读器的发布验收基础设施和缺陷修复。
架构：保留 Rust/Axum + SQLite API 与 React/Foliate 阅读器；Vitest 验证 IndexedDB 和同步，Playwright 使用生产构建及独立样书目录，CI 执行容器运行验收。

1. 引入 fake-indexeddb，覆盖进度/队列原子性、旧响应、版本/编码/身份隔离、缓存清理、退出和配额故障；修复可复现问题。
2. 引入 Chromium/WebKit Playwright，启动 Axum 托管的生产构建，每个测试隔离数据库与样书，保留失败 trace、截图与服务端日志。覆盖认证、组织、阅读恢复、断网、设置、版本变化和清理。
3. 扩展 TXT/EPUB/CBZ 夹具；验证有许可的无 DRM MOBI。AZW3/KF8 明示实验性，失败建议转 EPUB。缺样书不得标为通过。
4. CI 增加浏览器和容器运行验收；更新 README/TODO 与验收记录。真机覆盖桌面、Android、iPhone Safari/PWA，手机通过可信 HTTPS 访问。无设备时明确待验收。

发布门槛：Rust fmt/Clippy/test/release，前端 lint/test/build，Chromium/WebKit，Docker 非 root/只读书库/可写数据/重启持久化/退出/SIGTERM，以及四格式和真机阅读闭环均通过。
不扩展多用户、PDF、整本下载；不增加生产测试后门；现有 API 与较大百分比同步规则保持兼容。

## 执行记录（2026-09-08）

- [x] IndexedDB 回归：使用 `fake-indexeddb` 验证原子进度/队列、乱序响应、重试、隔离、清理、退出冻结和配额错误。
- [x] 浏览器闭环：Playwright 1.63.0 生产构建 + Axum 独立夹具；Chromium 9/9、WebKit 9/9 通过。
- [x] 格式实样：加入 Project Gutenberg ebook 11 无 DRM MOBI，SHA-256 记录在验收文档；Rust 解析和 Foliate 实际阅读均通过。加入有效无封面 EPUB、损坏 EPUB、GBK TXT 等夹具。
- [x] CI：保留 Rust/前端检查，加入浏览器任务、失败产物上传和容器冒烟脚本。
- [x] 文档：README、TODO 和 [`docs/offline-mvp-acceptance.md`](../offline-mvp-acceptance.md) 已更新。
- [ ] 外部环境：Docker、桌面 Edge、Android Chrome、iPhone Safari/PWA、可信 HTTPS、真实配额和 AZW3/KF8 仍待验收，不能用本地自动化结果替代。
