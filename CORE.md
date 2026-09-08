对。把目标重新锁死之后，我们其实不需要“做另一个 Kavita/Komga”，而是应该非常克制：

> **目标只有四类文件：EPUB / CBZ / MOBI / TXT。**
>
> **三个核心能力：Web 阅读、阅读进度同步、手机 PWA。**
>
> 其他功能都应该围绕这三个目标服务，而不是先做一个庞大的电子书管理平台。

我会把几个项目拆成“只学它最强的一部分”。

| 项目         | 我们主要学习什么                                | 不建议学习什么               |
| ------------ | ----------------------------------------------- | ---------------------------- |
| **Komga**    | 文件系统扫描、目录即分类、原文件不动、增量索引  | 漫画 Series/Volume 复杂模型  |
| **Kavita**   | 阅读器 UX、Continue Reading、阅读进度、阅读状态 | 重度文件名推断、复杂媒体识别 |
| **Stump**    | 后端模块化、轻量架构、API 与 Reader 解耦        | 目前不必照搬完整多客户端体系 |
| **TaleBook** | TXT、MOBI、格式转换、中文小说处理               | Calibre Library 接管文件     |
| **Legado**   | TXT 章节识别、中文网文文本处理                  | 网络书源系统暂时不要         |

然后我们自己的项目反而会非常干净。

------

# 1. Komga：重点学它的「Filesystem First」

这是我现在认为我们最应该坚持的原则。

假设 NAS 是：

```text
/books
├── 小说
│   ├── 金庸
│   │   ├── 射雕英雄传.epub
│   │   └── 神雕侠侣.txt
│   └── 刘慈欣
│       └── 三体.mobi
│
└── 漫画
    ├── 龙珠
    │   ├── 01.cbz
    │   └── 02.cbz
    └── 火影忍者
```

我们的应用不要试图：

```text
导入
↓
复制
↓
重新命名
↓
重建目录
```

而是：

```text
/books
  ↓
Scanner
  ↓
SQLite Index
```

SQLite 里保存的是：

```text
/path/小说/金庸/射雕英雄传.epub

title
author
cover
format
size
mtime
metadata
reading_progress
```

原文件完全不动。

### 这样有几个巨大优势

你甚至可以直接：

```yaml
volumes:
  - /mnt/books:/books:ro
```

**只读挂载。**

这意味着我们的服务器理论上连“破坏用户书库”的能力都没有。

而且数据库坏了也无所谓。

直接：

```text
删 database
↓
重新扫描
↓
恢复书库
```

阅读进度单独备份即可。

这个思想非常值得从 Komga 学。

------

# 2. Kavita：只学它的阅读体验

Kavita 最大的参考价值，不是 Scanner，而是：

> **Reader 应该是什么体验。**

尤其是首页。

不要做传统电子书管理器：

```text
首页
├── 作者
├── 标签
├── 格式
├── 出版社
├── ISBN
├── 语言
...
```

用户打开 PWA 最想看到的其实是：

```text
继续阅读

三体
████████░░ 76%

射雕英雄传
████░░░░░░ 41%

龙珠 23卷
██████░░░░ 62%
```

然后下面才是：

```text
最近添加

小说

漫画

目录
```

这就是 Kavita 值得学的地方。

------

# 3. 阅读进度模型要自己设计好

这是整个项目一个非常重要的底层设计。

千万不要统一成：

```json
{
  "progress": 0.53
}
```

因为 EPUB、TXT、CBZ 的阅读方式完全不同。

建议底层做统一接口：

```text
ReadingPosition
```

但允许每种格式拥有自己的 locator。

例如：

### EPUB

```json
{
  "type": "epub",
  "chapter": "chapter_12.xhtml",
  "locator": "epubcfi(/6/14!/4/2/8)",
  "progress": 0.426
}
```

CFI 非常重要。

因为仅保存：

```text
第12章 43%
```

字体大小一改，位置可能就漂了。

------

### TXT

我们实际上先把 TXT 虚拟拆成 chapter：

```json
{
  "type": "txt",
  "chapter": 53,
  "offset": 18423,
  "progress": 0.338
}
```

最好保存：

```text
chapter_id
+
character offset
```

而不是像 EPUB 那样依赖 DOM。

------

### CBZ

就更简单：

```json
{
  "type": "cbz",
  "page": 43,
  "page_progress": 0.2,
  "progress": 0.617
}
```

甚至第一版只存：

```text
page
```

已经完全够用了。

------

# 4. Stump：学习代码架构，而不是产品功能

这是我特别建议 Codex 去读的项目。

我们的后端最终完全可以形成：

```text
server
├── api
├── library
├── scanner
├── metadata
├── reader
├── progress
└── formats
    ├── epub
    ├── txt
    ├── cbz
    └── mobi
```

最关键的是：

```text
Format
```

做统一 abstraction。

例如概念上：

```rust
trait Publication {
    fn metadata(&self) -> Metadata;
    fn cover(&self) -> Cover;
    fn toc(&self) -> Vec<Chapter>;
}
```

但下面：

```text
EPUB
TXT
CBZ
MOBI
```

各做各的。

不要试图把四种文件真的转换成同一种文件格式。

只需要最终向前端暴露统一 API。

------

# 5. 我们甚至可以设计一个统一 Publication 模型

这是我觉得比直接照抄四个项目更漂亮的地方。

数据库核心：

```text
Library
   │
   ↓
Directory
   │
   ↓
Publication
```

Publication：

```text
id
path
filename

format
├── epub
├── mobi
├── txt
└── cbz

title
author
cover
metadata
size
mtime
```

然后：

```text
Publication
   │
   ├── Metadata
   ├── TOC
   ├── Assets
   └── ReadingState
```

这样数据库并不需要：

```text
Novel
Comic
Book
Manga
Series
Volume
Chapter
Issue
```

这么多不同实体。

全部都是：

> **Publication**

至于它怎么读，由 format adapter 决定。

这会大幅降低系统复杂度。

------

# 6. EPUB：直接阅读，不做转换

这是最标准的格式。

流程：

```text
EPUB
 ↓
ZIP reader
 ↓
META-INF/container.xml
 ↓
OPF
 ↓
manifest / spine / TOC
 ↓
Reader
```

浏览器侧可以考虑：

**epub.js**

这是目前非常成熟的一条路线。

服务器甚至不一定需要把 EPUB 完整解压。

可以提供：

```text
/api/books/{id}/resource/{path}
```

浏览器按需加载：

```text
chapter.xhtml
css
image
font
```

这样非常优雅。

------

# 7. TXT：这是我们最应该认真做的格式

因为中文自托管小说项目最大的差异化反而很可能在这里。

流程建议：

```text
TXT
 ↓
Encoding Detection
 ↓
UTF-8 Normalize
 ↓
Chapter Detection
 ↓
Virtual TOC
 ↓
Virtual Chapters
```

例如：

```text
第一章
第1章
第001章
第一回
卷一
楔子
序章
终章
番外
```

需要中文规则。

这里：

> **TaleBook + Legado**

是最值得参考的。

TXT 不需要真的转换成 EPUB。

我们可以生成：

```text
TXT index cache
```

比如：

```text
book.txt

book.idx
{
  Chapter 1: byte 0 - 18233
  Chapter 2: byte 18234 - 39192
  ...
}
```

以后读第 53 章：

```text
seek
↓
读取对应 byte range
```

不用整本 TXT 每次读进内存。

对于几十 MB 的网文非常舒服。

------

# 8. MOBI：我建议不要自己写阅读器

这里反而应该保持克制。

浏览器生态对于：

```text
EPUB
```

非常成熟。

对于：

```text
MOBI
AZW
AZW3
```

明显差很多。

所以 MOBI 我建议：

```text
book.mobi
    │
    │ 原文件不动
    ↓
Conversion Worker
    ↓
cache/book.epub
    ↓
EPUB pipeline
```

即：

> **MOBI 只是一个输入格式，而不是一个 Reader 格式。**

服务器第一次打开：

```text
MOBI
↓
转换 EPUB
↓
缓存
```

以后一直读缓存。

类似：

```text
/cache
└── converted
    └── sha256(book.mobi)
        └── book.epub
```

如果原文件：

```text
mtime
size
hash
```

发生变化，就重新生成。

这个地方可以借鉴 TaleBook。

------

# 9. CBZ：甚至比 EPUB 更容易

CBZ 本质：

```text
ZIP
├── 001.jpg
├── 002.jpg
├── 003.jpg
└── ...
```

我们只需要：

```text
CBZ
 ↓
archive index
 ↓
natural sort
 ↓
pages
```

服务器：

```http
GET /api/publications/123/pages

[
  "001.jpg",
  "002.jpg",
  ...
]
```

然后：

```http
GET /api/publications/123/page/42
```

就可以了。

第一版漫画阅读器甚至只有三个模式：

```text
单页
双页
Webtoon连续滚动
```

已经覆盖绝大多数场景。

后面再加：

```text
LTR
RTL
Fit Width
Fit Height
```

------

# 10. PWA 应该从第一天就是核心架构

这一点我反而不建议：

> 先开发 Web，以后再支持 PWA。

而应该：

> **Web App 本身就是 PWA。**

结构：

```text
Browser
   │
   ├── Desktop
   │
   ├── Mobile
   │
   └── Installed PWA
```

完全同一个前端。

第一版至少应该有：

```text
manifest.webmanifest
Service Worker
Responsive Layout
Fullscreen Reader
Touch Gestures
Add to Home Screen
```

------

# 11. PWA 可以顺手解决一个非常好的需求：离线阅读

这个甚至可以成为我们项目后面的亮点。

例如用户点：

> 下载到设备

前端：

```text
Service Worker
     +
IndexedDB
```

缓存：

```text
metadata
chapters
images
reading position
```

于是：

```text
NAS 在线
 ↓
下载一本书
 ↓
离开家
 ↓
手机没连 NAS
 ↓
PWA 仍然能看
 ↓
回家联网
 ↓
同步进度
```

而且完全不用：

```text
Android APK
iOS App
Electron
Tauri
```

这就是 PWA 路线最大的价值。

不过这个可以放到 V2。

------

# 12. 所以我会把整个系统压缩成 5 个核心模块

最终其实就是：

```text
                    ┌──────────────┐
                    │ NAS Filesystem│
                    └───────┬──────┘
                            │
                         Scanner
                            │
                            ▼
                     ┌────────────┐
                     │   SQLite   │
                     └─────┬──────┘
                           │
                  ┌────────┴────────┐
                  │   Format Layer  │
                  │                 │
          ┌───────┼───────┬────────┤
          ▼       ▼       ▼        ▼
        EPUB     TXT      CBZ      MOBI
                                   │
                                   ▼
                                  EPUB
                  │
                  ▼
               REST API
                  │
                  ▼
              Web / PWA
                  │
           ┌──────┴──────┐
           ▼             ▼
       Text Reader    Comic Reader
```

你会发现：

**其实根本不需要“大型电子书平台”。**

------

# 13. 功能优先级我会这样砍

### V0.1

只实现：

```text
✓ 添加 Library Path
✓ 扫描
✓ EPUB
✓ TXT
✓ CBZ
✓ MOBI → EPUB
✓ 封面
✓ 目录
✓ 阅读器
✓ 阅读进度
✓ PWA
```

到这里其实已经是一个完整产品。

### V0.2

再做：

```text
✓ 搜索
✓ 作者
✓ 最近添加
✓ Continue Reading
✓ 阅读设置
✓ 深色模式
✓ 多 Library
```

### V0.3

才做：

```text
✓ 多用户
✓ 离线阅读
✓ OPDS
✓ Kobo/KOReader
✓ Metadata scraper
```

而这些我反而建议不要碰太早：

```text
✗ 在线书源
✗ AI metadata
✗ 用户上传
✗ Calibre Library
✗ 自动整理文件
✗ 自动改名
✗ Series filename guessing
✗ 阅读社区
✗ 书评
✗ 推荐算法
```

这些全都会让项目开始膨胀。

------

## 我现在对这个项目的架构定义

如果让我用一句话写进 README：

> **A lightweight, filesystem-first self-hosted reading server for EPUB, MOBI, TXT and CBZ, built around a modern PWA reader.**

中文可以叫：

> **一个以文件系统为核心、面向 EPUB、MOBI、TXT 与 CBZ 的轻量自托管 PWA 阅读服务器。**

而几个参考项目的角色已经非常清楚：

```text
Komga
  ↓
Filesystem / Scanner

Stump
  ↓
Architecture

Kavita
  ↓
Reader UX / Progress UX

TaleBook
  ↓
MOBI / TXT

Legado
  ↓
Chinese TXT Parsing
```

其中我认为**最值得我们自己创新的恰恰是 TXT + EPUB 的统一文字阅读器**：底层两个 parser，上层却共用同一套排版、主题、字号、行距、翻页/滚动、进度逻辑。这样对用户来说根本不用知道自己正在读的是 TXT 还是 EPUB——这会比很多现有自托管项目做得更干净。