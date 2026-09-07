# 在线优先缓存验收记录

日期：2026-09-07

## 已实现

- Service Worker 预缓存应用外壳、manifest、图标和构建生成的阅读器动态资源；更新通过提示后刷新，认证 API 不进入 Cache Storage。
- IndexedDB 使用独立的 `moth-reader-v3` 数据库，按 origin、服务器实例和账号隔离。书籍元数据单独保存，章节、CBZ 页面、EPUB 资源和本地进度按内容哈希建立索引。
- 在线阅读成功访问的章节或页面自动写入缓存。TXT 的缓存身份包含规范化编码和 parser 版本；旧版整本分块数据只保留在隔离区用于清理诊断，不参与新的阅读入口。
- 断网启动时，setup/session/books/book 查询允许本地读取；书架只显示存在已缓存阅读单元的书并标注 Partial cache。未缓存章节或页面显示需要联网的明确错误。
- EPUB/MOBI 保留 Foliate 在线解析；定位事件缓存当前章节和已访问资源，离线使用已缓存章节重新生成 Blob，并按原始资源路径重建 CSS 依赖。CBZ 在线使用 Range，成功加载的页面按页保存，离线不重建整本 ZIP。
- 进度在 IndexedDB 中与待同步操作同一事务立即写入；每本书在每个内容版本＋TXT 编码上下文中只保留最新待发送操作，切换上下文不会丢掉其他未同步记录。响应在事务中校验操作 ID，乱序响应不会覆盖较新的本地位置。回到联网、前台或重新登录后自动重试。
- 服务端生成内容版本快照，Range/ETag 始终对应已校验的 SHA-256 字节；源文件在快照期间变化会返回 `content_changed` 并要求重新扫描。
- EPUB、MOBI6、KF8、TXT 在 Blob 生成前移除脚本、事件属性和危险 URL，并注入章节级 CSP；CSS 外链和危险导入会被清理，Foliate 目录递归支持 `subitems` 和 `children`，漫画重试与按钮事件已隔离。ZIP Range、MOBI 原始文件和服务器读取都有有限超时，切书时取消在途读取。
- 主动退出冻结本地写入、清 IndexedDB 与 Moth 自有 Cache Storage；离线退出留下待执行的服务器登出标记。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | PASS（17 格式、21 服务端单元、10 API 集成，共 48 项） |
| `cargo build --release --workspace` | PASS |
| `pnpm --dir web lint` | PASS |
| `pnpm --dir web test --run` | PASS（39 tests） |
| `pnpm --dir web build` | PASS |
| Playwright Chromium/WebKit | 未配置，待补充浏览器夹具 |
| GitHub Actions | 已配置，待远端运行确认 |

## 待完成的真实环境验收

Docker 当前未安装，compose 构建、非 root、只读 `/books`、优雅停机和 setup/login/restart/logout 仍待容器环境验证。桌面 Chrome/Edge、Android Chrome、iPhone Safari/PWA 的断网冷启动、配额不足、横竖屏和触控翻页仍待真机验证。真实 MOBI/AZW3（含 KF8）和含恶意脚本/资源的 EPUB 仍需浏览器夹具验证；自动化单测不能替代这些验收。
