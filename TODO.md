# Moth 个人核心版检查清单

产品边界以 [`CORE.md`](CORE.md) 为准。本文件只保留仍需要验证的核心行为。

## 功能

- [x] 单一只读书库根目录、增量扫描、唯一移动沿用 ID、重复文件保持独立。
- [x] 一级书架 `hide` 文件标记、默认折叠“更多书架”入口和继续阅读过滤。
- [x] EPUB、TXT、CBZ、经典无 DRM MOBI 的索引、封面、资源和转换链路。
- [x] 首页继续阅读、分类/系列目录预览；删除最近添加、搜索、筛选及小说/漫画栏目。
- [x] EPUB/TXT 共享 Foliate 文字 reader 外壳、TOC、分页/滚动、字号/行距/明暗主题。
- [x] 服务端 EPUB CFI、TXT 章节/UTF-16 offset、CBZ 页/页内进度。
- [x] 扫描状态轮询和 reader 退出/切后台时的最后一次进度 flush。

## 必须持续验证

- [ ] 真实 EPUB TOC、复杂 XHTML 和 CFI 在 Chromium/WebKit 中跳转与恢复。
- [ ] UTF-8、UTF-16、GBK、GB18030、Big5 TXT 的章节、编码切换和章内 offset。
- [ ] CBZ 单页、双页、Webtoon 懒加载、LTR/RTL、移动横竖屏和滚动进度。
- [ ] MOBI 缓存命中、源文件变化、转换器版本变化、并发去重和失败重试。
- [ ] 源目录只读、扫描中途 I/O 失败不 prune、重启后索引与进度行为。
- [ ] 约千本 EPUB 压力扫描分别记录服务 RSS、容器文件缓存和三次重复扫描的峰值/空闲值，并在 512 MiB 容器限额内完成。
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

## 本轮实现记录（2026-09-10）

- 已完成 Rust 格式检查、Clippy、全量 Rust 测试，以及前端 TypeScript、ESLint、Vitest、生产构建和 Service Worker 预缓存版本生成。
- 已用本地验证书库检查 CBZ 页流、缩略图、尺寸缓存和 EPUB Range 响应；响应体长度与 `Content-Length` 一致，尺寸缓存可在重复请求中命中。
- 真实生产书库、512 MiB 无 swap 容器和 Android 已安装 PWA 当前不可用，因此千本扫描的 RSS/匿名内存对比、真实设备全屏和横竖屏验收仍需在目标环境完成。
- Playwright Chromium 未安装，浏览器 E2E 未运行；安装浏览器后需继续执行 `pnpm --dir web test:e2e`。
