# Moth 待办计划(TODO)

当前状态:Phase 0(基础)+ 单用户重构 + Phase 1(图书馆基础)已完成。以下为未进行的计划,按里程碑排序。

## M2 — Phase 2:阅读引擎 + 阅读器 UI(下一步)

### 阅读引擎(服务端,复用 Phase 1 解析结果)
- [ ] EPUB:按 spine 提供章节 XHTML(章节内容与资源重写已就绪,待接入渲染)
- [ ] TXT / MOBI:章节文本已渲染为 HTML,直接供阅读器使用
- [ ] CBZ:按页提供图片(页面读取已就绪,待接入阅读器)

### 翻页式阅读器(文本类 EPUB/TXT/MOBI)
- [ ] 客户端 CSS Multi-Column 布局分页(固定视口高度 + column-width,页 = 列)
- [ ] 上一页 / 下一页(点击、方向键、左右键)
- [ ] TOC 抽屉、章节跳转
- [ ] 字号 / 行距 / 主题设置
- [ ] 进度按 (chapter_index, page_index, percent) 记录,翻页防抖保存到服务端

### 漫画阅读器(CBZ)
- [ ] 图片页宽度适配,方向键/点击翻页
- [ ] 缩略图页导航
- [ ] 进度按页记录

### 验收
- [ ] 四格式各完整读一遍(翻页、跳章、进度恢复)
- [ ] 浏览器验证 + 前端测试

## M3 — Phase 3:离线优先 / PWA

- [ ] `vite-plugin-pwa`(generateSW)预缓存应用外壳 + `navigateFallback` 到 index.html
- [ ] 封面 `CacheFirst` 运行时缓存(URL 带内容哈希)
- [ ] 图书按书 id 显式下载进 IndexedDB(不塞 SW Cache,避免大 CBZ 挤爆配额)
- [ ] 已下载书离线可读;支持驱逐/取消下载
- [ ] 离线进度写 IndexedDB(立即生效),联网后队列同步 `PUT /progress`
- [ ] 认证保持同源 HttpOnly Cookie;进度写保持网络优先

## M4 — Phase 4:打磨与收尾

- [ ] 损坏文件、无封面、未知编码、AZW3/KF8 等边缘状态在 UI 的优雅展示
- [ ] 重新扫描策略(文件变更检测、扫描进度)、data 目录备份说明
- [ ] 测试补齐(每种格式 fixture 单测、API 集成测试、前端测试、浏览器验证)
- [ ] CI 扩展(新 crate 检查)、README/docs 更新、验收记录

## 待验证项(不阻塞主流程,但需在对应里程碑补齐)

- [ ] **MOBI 实样验证**:需要一个真实 MOBI/AZW3 文件测试 `mobi` crate 解析。
      `mobi` crate 不带测试夹具,当前仅验证了损坏文件的错误路径;若对 AZW3/KF8
      支持不足,UI 需提示"建议转 EPUB/AZW3"。
- [ ] **Phase 0 遗留的 Docker 验收**(需 Docker 环境,`docs/phase-0-acceptance.md`
      中标记 PENDING 的项目):
  - [ ] `docker compose config` / `docker compose build` / `docker compose up -d`
  - [ ] 容器内 setup → login → restart → logout 冒烟测试
  - [ ] `/books` 以只读挂载、进程 UID 非 0、`/data` 可写
  - [ ] 优雅停机(SIGTERM,无 panic、无残留进程)

## 已完成(供参考,不再处理)

- [x] Phase 0:服务端基础、SQLite、单用户认证、React 外壳、CI
- [x] Phase 0.5:admin → user 全面重构(迁移 0002)
- [x] Phase 1:格式解析核心(moth-format)、扫描器与数据库(迁移 0003)、
      图书 API、书架 UI(网格/搜索/格式筛选/进度/重新扫描)
