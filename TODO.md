# Moth 待办计划(TODO)

当前状态：Phase 0(基础)+ 单用户重构 + Phase 1(图书馆基础)+ Phase 2(阅读器)+ 在线优先缓存 + M5/M6 栏目与书籍系列整理已实现，待真实浏览器与容器验收。

## M5/M6 — 栏目、书籍系列与单本书（已实现）

- [x] 栏目和系列数据迁移；旧书自动进入固定“未分类”栏目
- [x] 手动创建、重命名、删除栏目/系列；系列整组移动与册序调整
- [x] 单书批量归类到栏目或系列，冲突和无效目标使用事务回滚
- [x] 扫描唯一改名/移动沿用书籍 ID、进度与人工归属；缺失文件保留记录
- [x] 分层书架、面包屑、全库搜索、移动端可用的多选归类
- [x] IndexedDB 保存最近分类快照；断网仅展示本机已有缓存内容
- [x] 缓存容量提示提供清理入口，清理内容保留阅读进度和待同步队列
- [ ] Playwright 浏览器夹具与真机验收

## M2 — Phase 2:阅读引擎 + 阅读器 UI(已实现)

> 技术选型已定稿,见 `docs/reader-tech-selection.md`(EPUB/MOBI 走 foliate-js,服务端只做
> metadata + 提供原始文件 HTTP Range;TXT 走自研 Novel Parser + TextPublication 喂 Foliate
> paginator;CBZ 走自研 ComicEngine + zip.js)。

### 阅读引擎(服务端,复用 Phase 1 解析结果)
- [x] EPUB/MOBI 使用 foliate-js，EPUB 与 CBZ 原始文件支持 HTTP Range
- [x] TXT 章节 HTML、手动编码选择与 Foliate paginator
- [x] CBZ 按页读取、缩略图、前后页预加载与缓存回收

### 翻页式阅读器(文本类 EPUB/TXT/MOBI)
- [x] CSS Multi-Column/Foliate 分页、点击与键盘翻页
- [x] TOC 抽屉、章节跳转、字号/行距/主题设置
- [x] CFI/百分比恢复与串行进度保存（文件版本或 TXT 编码变化时丢弃旧定位）

### 漫画阅读器(CBZ)
- [x] 图片宽度/高度适配、方向键/点击翻页
- [x] 缩略图页导航与按页进度

### 验收
- [ ] 四格式各完整读一遍(翻页、跳章、进度恢复)
- [x] 前端 lint、单测与生产构建
- [ ] 浏览器验证

## M3 — 在线优先缓存 / PWA（已实现，待真机验收）

- [x] Service Worker 预缓存应用外壳与构建生成的阅读器动态资源（构建脚本注入，行为等价 generateSW），更新提示后刷新
- [x] 只缓存实际访问过的 TXT/EPUB/MOBI 章节、CBZ 页面及其必要资源
- [x] 缓存按服务器实例、账号、内容哈希、编码和解析器版本隔离
- [x] 离线启动显示已有缓存，未缓存单元明确提示需要联网
- [x] 进度在 IndexedDB 中立即保存，联网后按书串行同步并按较大百分比解决冲突
- [x] 认证响应不进入 Service Worker；退出冻结在途写入并清理 Moth 自有缓存
- [ ] 清理缓存入口、容量统计及真实配额不足提示的浏览器验收

## M4 — Phase 4:打磨与收尾(进行中)

- [ ] 损坏文件、无封面、未知编码、AZW3/KF8 等边缘状态在 UI 的优雅展示
- [x] 重新扫描失败保护、文件变更检测、data 目录备份说明
- [x] Rust/API/前端单测与 CI（Rust 48 tests，前端 39 tests）；[ ] Playwright 浏览器夹具与真机验收
- [x] README/TODO 更新；[ ] Docker 与移动端验收记录

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

- [ ] **在线优先浏览器夹具**：仓库当前未安装 Playwright，需在具备浏览器运行时的环境
      中补充 Chromium/WebKit 的断网、缓存版本隔离、进度乱序和退出清理测试。

## 已完成(供参考,不再处理)

- [x] Phase 0:服务端基础、SQLite、单用户认证、React 外壳、CI
- [x] Phase 0.5:admin → user 全面重构(迁移 0002)
- [x] Phase 1:格式解析核心(moth-format)、扫描器与数据库(迁移 0003)、
      图书 API、书架 UI(网格/搜索/格式筛选/进度/重新扫描)
- [x] Phase 2:Foliate 阅读器、CBZ 阅读器、Range 文件接口、CFI 进度
- [x] 在线优先 Service Worker、已读内容缓存与进度同步
