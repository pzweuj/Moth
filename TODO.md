# Moth 个人核心版检查清单

产品边界以 [`CORE.md`](CORE.md) 为准。本文件只保留仍需要验证的核心行为。

## 功能

- [x] 单一只读书库根目录、增量扫描、唯一移动沿用 ID、重复文件保持独立。
- [x] EPUB、TXT、CBZ、经典无 DRM MOBI 的索引、封面、资源和转换链路。
- [x] 首页继续阅读、最近添加和目录；删除搜索、筛选及小说/漫画栏目。
- [x] EPUB/TXT 共享 Foliate 文字 reader 外壳、TOC、分页/滚动、字号/行距/明暗主题。
- [x] 服务端 EPUB CFI、TXT 章节/UTF-16 offset、CBZ 页/页内进度。
- [x] 扫描状态轮询和 reader 退出/切后台时的最后一次进度 flush。

## 必须持续验证

- [ ] 真实 EPUB TOC、复杂 XHTML 和 CFI 在 Chromium/WebKit 中跳转与恢复。
- [ ] UTF-8、UTF-16、GBK、GB18030、Big5 TXT 的章节、编码切换和章内 offset。
- [ ] CBZ 单页、双页、Webtoon 懒加载、LTR/RTL、移动横竖屏和滚动进度。
- [ ] MOBI 缓存命中、源文件变化、转换器版本变化、并发去重和失败重试。
- [ ] 源目录只读、扫描中途 I/O 失败不 prune、重启后索引与进度行为。
- [ ] Service Worker 不缓存 API、认证、章节、文件或漫画页。
- [ ] Docker 非 root、只读挂载、重启/SIGTERM，以及 Android Chrome/iPhone Safari/PWA。

## 发布门槛

```text
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
