# 离线阅读 MVP 开发验收复核（历史报告）

日期：2026-09-07。本文件记录整本下载方案的历史验收结果；随后产品范围已调整为“在线优先、只缓存已访问内容”。对应修复结果见 [offline-mvp-acceptance.md](offline-mvp-acceptance.md)。

修复版本已移除整本下载 UI，改为按章节/页面缓存，并加入服务器实例隔离、进度原子写入、操作 ID 校验、快照 ETag、MOBI 渲染前清理、嵌套目录和漫画重试修复。Docker、真实浏览器、移动端及真实 MOBI/AZW3 仍保持待验收状态。
本次为代码审查、现有测试复跑和定向运行验证；未执行真实浏览器、容器或移动设备验收。

## 已确认问题

| 优先级 | 位置 | 触发条件与结果 | 修复要求 |
| --- | --- | --- | --- |
| P1 | web/src/App.tsx:23 | 查询使用默认 online 网络模式。React Query 已检测离线时，setup/session/book 查询暂停，包含 IndexedDB 回退的 queryFn 不执行，页面可停留在加载状态。 | 本地读取不受在线状态门控；断网冷启动不等待认证网络请求。 |
| P1 | web/src/api.ts:350 | 本地下载为版本 A、服务器更新到 B，在线读取 B 章节后却按本地 detail 的 A 版本写入缓存，污染仍标记完整的旧下载。失败回退也没有验证请求版本与缓存版本相同。 | 仅向完全匹配的内容版本与编码缓存写入/回退。 |
| P1 | web/src/reader/ReaderPage.tsx:152、web/src/offline/db.ts:202 | 下载自动编码 TXT 后切换编码，立即更改下载记录的 txtEncoding，未下载全部新编码章节，也未更新缓存目录。断网后请求不存在或不完整的章节。 | 阅读偏好与完整下载编码分离；新编码完整暂存提交后才能替换。 |
| P1 | web/src/api.ts:280、web/src/reader/useProgressSaver.ts:29 | 全局 flushPendingProgress 与阅读器各有独立同步路径。旧操作网络响应可在新位置写入后无条件覆盖本地 progress；hook 的串行链不能保护全局同步。 | 全局按书串行，响应应用需在事务内检查操作身份，保留更新的本地位置。 |
| P1 | web/src/reader/useProgressSaver.ts:52、157 | 新位置先放内存，持久化在延迟后的网络发送串行链内执行；前一个网络请求挂起时，后续本地位置也无法写入。切后台只有 visible 时重试，没有 hidden/pagehide 持久化。 | 本地持久化独立于网络队列，及时保存并处理页面生命周期。 |
| P1 | crates/moth-server/src/books.rs:500 | 原始文件 ETag 取数据库扫描哈希，实际读取当前文件。扫描后文件替换、尚未重扫时，仍用旧 ETag 返回新字节，If-Match 无法识别。 | 返回字节必须与声明的内容版本绑定，并覆盖下载期间文件变化。 |
| P1 | web/vendor/foliate-js/mobi.js:849、1172 | MOBI6 和 KF8 章节直接生成 Blob，没有经过 React 安装的 data transform。清理与章节 CSP 要等 iframe load 后才执行；sandbox 仍禁止脚本，但不满足渲染前统一清理，不能宣称主动资源请求已全面隔离。 | 在所有章节生成 Blob 前统一清理并注入 CSP，再做恶意章节浏览器验证。 |
| P1 | web/src/offline/db.ts:268、388、461 | 分块下载的清理、提交、打开使用 chunks.getAll()，把整个本地书库的二进制块读入内存后筛选。大 CBZ/多书库可能造成很高内存峰值。 | 为书籍/下载版本建立索引，按范围读取，清理用游标/键，ZIP 离线源按需读取。 |
| P2 | web/src/reader/FoliateTextReader.tsx:28 | 展开目录只读 children，但 Foliate EPUB/MOBI 返回 subitems；二级及以下目录不会出现。 | 按实际引擎目录结构递归并添加多层目录验证。 |
| P2 | web/src/reader/ComicReader.tsx:193 | 重试成功只缓存 URL，没有 setSrc；重渲染不触发依赖未变化的加载 effect。重试按钮点击还会冒泡到翻页容器。 | 成功恢复当前页图像，阻止按钮触发翻页，并处理过期响应。 |

## 测试证据与覆盖边界

- 本次 cargo test --workspace：47 项通过（16 格式、21 服务端单元、10 API 集成）。
- 本次 pnpm --dir web test --run：9 文件、37 项通过。
- 使用安装的 @tanstack/react-query，onlineManager.setOnline(false) 后创建采用项目默认配置的 QueryClient，调用 fetchQuery：输出 calls=0、fetchStatus=paused。该验证证明离线门控问题，不代替浏览器冷启动验收。
- 离线 db.test.ts 仅测试编码匹配纯函数，未覆盖 IndexedDB 下载事务、配额、取消、旧版本保留。
- useProgressSaver.test.ts 调用不带 contentVersion 的旧进度路径，未覆盖新增 IndexedDB/修订同步分支。
- 未发现 Playwright 配置或测试；此前记录的服务器停止后外壳启动不能代替设备真正断网；此前阅读器还停留在 Opening，未完成阅读闭环。
- Docker、Chrome/Edge、Android、iPhone Safari/PWA、真实 MOBI/AZW3 仍未验收。既有 fmt/Clippy/lint/build 通过记录属于工程检查，不是产品验收。

## 计划符合度与下一步

P0/P1、P2、P3 均为部分实现，不能只将剩余工作归为外部环境验收。先修复上述 P1 和 P2 问题，再补状态机、IndexedDB 和并发回归测试，最后执行四格式在线下载→断网冷启动→阅读→保存→联网同步及退出清除的浏览器闭环。

额外计划偏差（仅针对旧整本下载方案）：当时使用自定义 Service Worker 脚本，且整本下载数据模型不适合在线优先缓存。修复版本已将旧数据隔离到独立数据库，加入 parser_version、服务器实例 ID、按单元索引、Cache Storage 清理和在途写入排空；真实浏览器与容器验收仍按新范围执行。
