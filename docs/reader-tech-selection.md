# Moth 阅读器技术选型与路线(计划书)

> 状态:已收敛定稿。适用范围:M2(阅读引擎 + 阅读器 UI)。
> 一句话原则:**EPUB / MOBI 交给成熟电子书引擎;TXT / CBZ 不强行塞进大一统库。**

## 1. 选型总表

| 格式            | 后端 Rust                                       | 前端/PWA                                       | 选择      |
| ------------- | --------------------------------------------- | -------------------------------------------- | ------- |
| **EPUB**      | `zip` + `quick-xml` 做 metadata 即可             | **foliate-js + zip.js**                      | ⭐⭐⭐⭐⭐ |
| **MOBI/AZW3** | `mobi` crate 做 metadata                       | **foliate-js / mobi.js**                     | ⭐⭐⭐⭐⭐ |
| **TXT**       | **chardetng + encoding_rs + 自研 Novel Parser** | 自研 `TextPublication` + **Foliate paginator** | ⭐⭐⭐⭐⭐ |
| **CBZ**       | `zip` + `quick-xml` 读 ComicInfo               | **zip.js + 自研 ComicEngine**                  | ⭐⭐⭐⭐⭐ |

不做"四格式四套阅读框架"。核心结构只有两个阅读形态:

```text
                 Moth Reader
                      │
       ┌──────────────┴──────────────┐
       │                             │
  Reflowable                    Image based
       │                             │
 Foliate paginator              ComicEngine
       │                             │
 ┌─────┼─────┐                       │
EPUB  MOBI  TXT                     CBZ
```

## 2. EPUB:`foliate-js`

原生支持 EPUB 2/3、EPUB CFI、fixed-layout EPUB、分页、progress、search、annotations overlay、footnotes、reflow、MOBI/KF8、FB2、CBZ,且为 **MIT**。已被 Foliate 的多个稳定版本实际使用;自身 API 尚未稳定,因此 **pin commit / submodule**,不要 `npm install latest` 被 breaking change 反复炸。

```text
web/vendor/foliate-js
```

ZIP 层配 **`zip.js`**(与 foliate-js 同作者生态):

```text
EPUB URL
   ↓
zip.js HttpRangeReader
   ↓
foliate-js epub.js
   ↓
paginator
   ↓
Moth Reader UI
```

`zip.js` 的 `HttpRangeReader` 走 HTTP Range,只拉当前需要的 ZIP 内容,不下载整本书——非常适合自托管模型。**前提:服务端需提供原始文件的 HTTP Range 读取端点**(见 §8)。

## 3. MOBI / AZW3:也直接 `foliate-js`

不再另找一套 JS MOBI reader。foliate-js 自带 `mobi.js`,支持 MOBI / KF8 / AZW3 / combo MOBI:普通 MOBI 解压文本并按 `mbp:pagebreak` 分 section;KF8 按需解压,图片资源需要时再加载。

```text
EPUB ─ epub.js ─┐
                │
MOBI ─ mobi.js ─┼→ foliate view/paginator
                │
TXT ─ adapter ──┘
```

用户设置(字体 / 字号 / 行距 / 页边距 / 主题 / 翻页)三种小说格式共用。

**Rust 后端只做 metadata**:`mobi = "0.8"`(MIT),读取 title / author / publisher / ISBN / description / language / publish date / MOBI headers / text content。

```text
Server
  ↓
mobi crate
  ↓
只提 metadata / cover / basic information

真正阅读
  ↓
浏览器 foliate-js
```

**不**在服务器端把 MOBI 转 EPUB。

## 4. TXT:不要找"TXT Reader 库"

TXT 解析自己做。难点不在 `read_to_string()`,而在:

```text
编码识别
章节识别
脏文本净化
段落识别
大文件随机访问
阅读位置恢复
中文小说规则
```

这是相对 Kavita / BookLore 最有机会做出特色的部分。

### 编码:`chardetng` + `encoding_rs`

```text
BOM detection
      ↓
valid UTF-8?
      ↓ no
chardetng
      ↓
encoding_rs
      ↓
UTF-8 sidecar
```

`chardetng` 流式 feed 字节、识别 GBK / Big5 等传统编码;`encoding_rs` 负责实际转换。**必须增加手动选择编码**:任何 detector 都不可能是 100%,尤其中文短文本 `chardetng` 存在 GBK 判断准确性问题,GB18030 会识别成 GBK。UI 允许:

```text
自动
UTF-8
GB18030
GBK
Big5
UTF-16LE
UTF-16BE
```

### 章节:自研 clean-room 实现(参考 Legado 思路)

不依赖第三方库:

```rust
struct ChapterRule {
    name: String,
    pattern: Regex,
    priority: i32,
}
```

```text
BufReader
   ↓
逐行扫描
   ↓
Regex Candidate
   ↓
Heuristic Scoring
   ↓
Chapter Index
```

依赖最多 `regex` + `aho-corasick` + `memchr`;第一版 `regex + BufReader` 已足够快。

### 前端:让 TXT 也走 Foliate 的 paginator

不自己再造分页引擎。foliate-js 支持自定义实现 book interface 后交给 renderer:

```ts
class TextPublication {
    sections
    metadata
    toc
    getCover()
    ...
}
```

服务器:

```text
GET /books/123/chapters/25
```

返回:

```html
<article>
<h1>第二十五章</h1>

<p>……</p>
<p>……</p>
</article>
```

```text
TextPublication
      ↓
Foliate paginator
      ↓
Moth Reader
```

三种文字书使用**完全相同的分页器**,降低后续调中文分页 / 字号 / 行距 / 页边距 / 夜间模式 / 横竖排 / 翻页手势的工作量。

## 5. CBZ:`zip.js` + 自研 ComicEngine

第一版可先用 `foliate-js` 的 `comic-book.js`(把 CBZ 当 fixed-layout publication)快速跑通,但最终换成自研 **ComicEngine**——CBZ 太简单,不必迁就 EPUB renderer。

底层 `zip.js`:

```text
book.cbz
   ↓
HttpRangeReader
   ↓
zip.js
   ↓
entries
```

得到 `001.jpg / 002.jpg / 003.webp / 004.png / ComicInfo.xml`。ComicEngine 自己负责:

```text
单页
双页
RTL
LTR
Webtoon
Fit Width
Fit Height
缩放
手势
页预加载
```

## 6. CBZ 服务端几乎不用"解析库"

```toml
zip
quick-xml
image
```

服务器扫描:

```text
CBZ
 ↓
ZIP central directory
 ↓
ComicInfo.xml
 ↓
metadata

第一张 image
 ↓
cover thumbnail
```

阅读时服务器不负责解压图片,浏览器端 `zip.js` 走 HTTP Range 自己解,生成 image Blob——NAS CPU 几乎不干活。

## 7. 不采用的候选

- **`ebook-rs`**(纯 Rust + MIT,EPUB/MOBI/AZW3/KFX/FB2/KEPUB/CBZ/PDF/TXT/MD,更新激进,已加 CJK vertical、CBZ manga mode、TXT、WASM、UniFFI):**不作核心依赖**,太新、变化太快。适合 `watch / experiment / benchmark`,可写 `EbookRsAdapter` 实验,但 v0.1 不把四格式的成败押在上面。
- **Readium Web**:工程规范与标准化程度更高(2026 年已加 RTL + CJK、Decorator API、annotation locator),纯 EPUB 产品值得认真考虑;但其当前仍以 EPUB 为主要支持格式,CBZ/comics 是后续方向。Moth 需要 EPUB + MOBI + TXT + CBZ,**故当前选 Foliate-js**。

## 8. 依赖清单

### Rust

```toml
# TXT
chardetng
encoding_rs
regex

# EPUB / CBZ containers
zip
quick-xml

# MOBI metadata
mobi

# images
image

# misc
serde
serde_json
```

### Web

```text
foliate-js
@zip.js/zip.js
fflate
```

### 最终架构

```text
                    Moth
                       │
       ┌───────────────┴────────────────┐
       │                                │
     Novels                           Comics
       │                                │
       ▼                                ▼
    foliate                        ComicEngine
   paginator                            │
       │                             zip.js
 ┌─────┼─────┐                          │
 ↓     ↓     ↓                          ↓
EPUB  MOBI  TXT                        CBZ
 │     │     │
epub  mobi  TextPublication
.js   .js       │
                ↓
          Moth NovelEngine
```

## 9. 对现有代码的影响(M2 实施要点)

现有 `moth-format`(Phase 1)是"服务端全量解析,逐章返回 HTML";按本选型需要调整:

- **EPUB / MOBI**:服务端保留 metadata / cover 抽取(复用现有 `zip + quick-xml` 与 `mobi` crate 逻辑),阅读内容改由浏览器端 `foliate-js` 解析原始文件。
- **新增服务端端点**:提供原始图书文件的 **HTTP Range 读取**(`GET /books/{id}/file`,支持 `Range` 头),供 `zip.js HttpRangeReader` 使用;CBZ 同样受益。
- **TXT**:现有服务端章节 HTML 渲染(`moth-format` 的 `txt.rs`)与新选型天然衔接——`GET /books/{id}/chapters/{idx}` 返回的 `<article>` 直接喂给前端 `TextPublication`。
- **阅读器 UI**:重写为 foliate 分页器 + ComicEngine 两个形态;进度仍按 `(chapter_index, page_index, percent)` 记录,沿用现有 `PUT /progress`。
- **前端依赖**:`foliate-js` 以 `web/vendor/` pin commit 引入;`@zip.js/zip.js`、`fflate` 通过包管理引入。

## 10. 参考链接

- foliate-js(GitHub):<https://github.com/johnfactotum/foliate-js>
- zip.js 远程 ZIP 讨论(Range 模式):<https://github.com/gildas-lormeau/zip.js/discussions/637>
- mobi crate(Docs.rs):<https://docs.rs/mobi/latest/mobi/struct.Mobi.html>
- chardetng(Docs.rs):<https://docs.rs/chardetng/latest/chardetng/>
- ebook-rs(GitHub):<https://github.com/SV-stark/ebook-rs>
- Readium TS Toolkit 2026-07 Release Note:<https://blog.readium.org/release-note-readium-typescript-toolkit-july-2026/>
- Readium Web(GitHub):<https://github.com/readium/web>
