# Moth V0.2 交付清单

产品范围以 [`CORE.md`](CORE.md) 为最高优先级。本文件只记录 V0.2 的现行工作，不承诺旧的离线、组织或额外格式能力。

## 已落地

- [x] 干净初始 schema：`libraries`、`directories`、`publications`、`text_chapters`、`cbz_pages`、`reading_progress`。
- [x] 拒绝旧数据库并给出备份、删除 `moth.db`、重新扫描的明确提示。
- [x] TOML 多 Library 配置、`MOTH_BOOKS_DIR` 单库回退、重复 key/path 和无效配置校验。
- [x] 只读嵌套目录扫描：size/mtime 增量、SHA-256、唯一移动沿用 ID、重复哈希保持独立、完整扫描后 prune。
- [x] Publication API：首页、Library、目录面包屑、搜索、作者/格式/Library 筛选、封面、文件、章节、页面、扫描状态和服务端进度。
- [x] EPUB Range/ETag、TXT 编码与 byte-range 章节、CBZ 自然页序和按页解压、经典无 DRM MOBI→EPUB 原子缓存。
- [x] 判别式 EPUB/TXT/CBZ locator、content version 检查、版本变化的总体进度回退、按书防抖最后写入。
- [x] 简体中文响应式 PWA：首页继续阅读/最近添加/小说/漫画/目录，文字阅读器和 CBZ 单页/双页/Webtoon、LTR/RTL、适应宽度/高度、触摸翻页。
- [x] Service Worker 仅缓存 shell/构建资源；API、文件、章节、页面和认证响应不缓存。
- [x] Foliate vendor 只保留 EPUB、分页器、CFI 和传递依赖；删除 PDF/MOBI/KF8/FB2/ComicBook/OPDS/字典/demo/上游测试文件。

## 发布前验证

- [x] `cargo fmt --all --check`
- [x] `cargo clippy --workspace --all-targets --offline -- -D warnings`
- [x] `cargo test --workspace --offline`
- [x] `pnpm --dir web lint`
- [x] `pnpm --dir web test --run`
- [x] `pnpm --dir web build`
- [x] `pnpm --dir web test:e2e`（Chromium/WebKit，需提升本机浏览器进程权限）
- [ ] `docker compose config`、`docker compose build`、`python scripts/container-smoke.py`（需要 Docker daemon）
- [ ] 桌面 Edge、Android Chrome、iPhone Safari/PWA、可信 HTTPS 和真实容器重启/SIGTERM 验收

## 必须持续覆盖的场景

- [ ] TOML 多库、重复 key/path、缺失配置、无效路径和旧环境变量回退。
- [ ] 只读嵌套目录扫描、未变化/修改/唯一移动/重复文件/删除/中途 I/O 失败。
- [ ] EPUB、GBK/GB18030/Big5/UTF-8/UTF-16 TXT、CBZ 和真实经典无 DRM MOBI 的元数据、封面、目录、阅读及重启进度。
- [ ] MOBI 缓存命中、源文件变化、转换器版本变化、并发去重、原子失败和不支持格式提示。
- [ ] 每种 locator 的校验、版本回退、多设备最后写入；首页排序、全局搜索、作者/格式/Library 筛选和目录返回状态。
- [ ] CBZ 单页、双页、Webtoon、LTR/RTL、触摸和移动横竖屏。
- [ ] Service Worker Cache Storage/IndexedDB 不包含 API、章节、页面或认证响应。

## 明确不做

离线阅读、IndexedDB 队列、手工栏目/系列、批量归类、文件改名/复制、旧 `/books` 契约、多用户、OPDS、Kobo/KOReader、上传、在线书源、元数据抓取、AI、推荐、书评、AZW3/KF8、PDF、FB2。
