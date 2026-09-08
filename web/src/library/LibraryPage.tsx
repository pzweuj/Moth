import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Format, type LibrarySummary, type PublicationSummary } from "../api";

type Props = { onLogout: () => Promise<void> };

export function LibraryPage({ onLogout }: Props) {
  const [params] = useSearchParams();
  const libraryKey = params.get("library") ?? "";
  const browsePath = params.get("path") ?? "";
  const isBrowse = params.get("view") === "browse";
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [books, setBooks] = useState<PublicationSummary[]>([]);
  const [continueReading, setContinueReading] = useState<PublicationSummary[]>([]);
  const [recent, setRecent] = useState<PublicationSummary[]>([]);
  const [novels, setNovels] = useState<PublicationSummary[]>([]);
  const [comics, setComics] = useState<PublicationSummary[]>([]);
  const [directories, setDirectories] = useState<Array<{ name: string; path: string; publication_count: number }>>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ name: string; path: string }>>([]);
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState<Format | "all">("all");
  const [author, setAuthor] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const libs = await api.libraries(); setLibraries(libs);
      if (isBrowse && libraryKey) { const value = await api.browse(libraryKey, browsePath); setBooks(value.publications); setDirectories(value.directories); setBreadcrumbs(value.breadcrumbs); }
      else { const home = await api.home(); setContinueReading(home.continue_reading); setRecent(home.recently_added); setNovels(home.novels); setComics(home.comics); setBooks([]); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "书库加载失败"); }
    finally { setLoading(false); }
  }, [browsePath, isBrowse, libraryKey]);

  const searchBooks = useCallback(async () => {
    if (!search.trim() && format === "all" && !author && !libraryFilter) return;
    try { setLoading(true); setBooks(await api.publications({ q: search.trim() || undefined, format, author: author || undefined, library: libraryFilter || undefined })); } catch (reason) { setError(reason instanceof Error ? reason.message : "搜索失败"); } finally { setLoading(false); }
  }, [author, format, libraryFilter, search]);
  useEffect(() => { if (search || format !== "all" || author || libraryFilter) void searchBooks(); else void load(); }, [author, format, libraryFilter, load, search, searchBooks]);

  const authors = useMemo(() => [...new Set([...continueReading, ...recent, ...novels, ...comics, ...books].map((book) => book.author).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "zh-CN")), [books, comics, continueReading, novels, recent]);
  const scan = async (key: string) => { setScanning(key); try { await api.scan(key); } catch (reason) { setError(reason instanceof Error ? reason.message : "扫描失败"); } finally { setScanning(null); void load(); } };

  const isSearching = Boolean(search.trim() || format !== "all" || author || libraryFilter);
  const toolbar = <div className="library-toolbar"><input className="search-input" placeholder="搜索标题、作者或文件名" value={search} onChange={(event) => setSearch(event.target.value)} /><select value={format} onChange={(event) => setFormat(event.target.value as Format | "all")}><option value="all">全部格式</option><option value="epub">EPUB</option><option value="txt">TXT</option><option value="mobi">MOBI</option><option value="cbz">CBZ</option></select>{authors.length > 0 && <select value={author} onChange={(event) => setAuthor(event.target.value)}><option value="">全部作者</option>{authors.map((value) => <option key={value} value={value}>{value}</option>)}</select>}{!isBrowse && libraries.length > 1 && <select aria-label="书库" value={libraryFilter} onChange={(event) => setLibraryFilter(event.target.value)}><option value="">全部书库</option>{libraries.map((library) => <option key={library.key} value={library.key}>{library.name}</option>)}</select>}</div>;

  return <main className="home-shell"><nav className="home-nav"><Link className="wordmark" to="/">MOTH <span>个人书库</span></Link><div className="home-actions"><ThemeToggle /><button className="quiet-button" type="button" onClick={() => void onLogout()}>退出</button></div></nav>
    {error && <div className="form-error state-inline">{error}</div>}
    {isBrowse ? <><header className="library-head"><p className="eyebrow">目录 / {libraryKey}</p><h1>{breadcrumbs.at(-1)?.name ?? "目录"}</h1></header>{toolbar}<div className="breadcrumbs">{breadcrumbs.map((crumb) => <Link key={crumb.path} to={`/browse?view=browse&library=${encodeURIComponent(libraryKey)}&path=${encodeURIComponent(crumb.path)}`}>{crumb.name}</Link>)}</div><div className="directory-grid">{directories.map((directory) => <Link className="directory-card" key={directory.path} to={`/browse?view=browse&library=${encodeURIComponent(libraryKey)}&path=${encodeURIComponent(directory.path)}`}><strong>{directory.name}</strong><span>{directory.publication_count} 本</span></Link>)}</div><BookGrid books={books} loading={loading} /></>
      : <><header className="home-hero"><div><p className="eyebrow">FILESYSTEM FIRST / V0.2</p><h1>回到故事里。</h1><p>书库目录就是你的分类，不复制、不改名、不接管原文件。</p></div></header>{toolbar}{isSearching ? <Section title="搜索结果" books={books} loading={loading} showEmpty /> : <><Section title="继续阅读" books={continueReading} loading={loading} /><Section title="最近添加" books={recent} loading={loading} /><Section title="小说" books={novels} loading={loading} showEmpty /><Section title="漫画" books={comics} loading={loading} showEmpty /><section className="library-section"><div className="section-heading"><h2>目录</h2><button className="quiet-button" type="button" onClick={() => void load()}>刷新</button></div><div className="library-grid">{libraries.map((library) => <article className="library-card" key={library.key}><Link to={`/browse?view=browse&library=${encodeURIComponent(library.key)}`}><h3>{library.name}</h3><p>{library.publication_count} 本 · {library.directory_count} 个目录</p></Link><button className="quiet-button" type="button" disabled={scanning === library.key} onClick={() => void scan(library.key)}>{scanning === library.key ? "扫描中…" : "重新扫描"}</button></article>)}</div></section></>}</>}
  </main>;
}

function Section({ title, books, loading, showEmpty = false }: { title: string; books: PublicationSummary[]; loading: boolean; showEmpty?: boolean }) { if (!loading && books.length === 0 && !showEmpty) return null; return <section className="library-section"><div className="section-heading"><h2>{title}</h2></div><BookGrid books={books} loading={loading} /></section>; }
function BookGrid({ books, loading }: { books: PublicationSummary[]; loading: boolean }) { if (loading) return <p className="shelf-hint">正在扫描书库…</p>; if (books.length === 0) return <p className="shelf-hint">这里还没有书。</p>; return <div className="book-grid">{books.map((book) => <Link className="book-card" to={`/reader/${book.id}`} key={book.id}><div className="book-cover">{book.cover_url ? <img src={book.cover_url} alt="" loading="lazy" /> : <span>{book.source_format.toUpperCase()}</span>}</div><div className="book-info"><h3>{book.title}</h3><p>{book.author || "未知作者"}</p><small>{Math.round(book.progress * 100)}% · {book.library_name}</small></div></Link>)}</div>; }

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("moth:theme") === "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("moth:theme", dark ? "dark" : "light");
  }, [dark]);
  return <button className="quiet-button" type="button" onClick={() => setDark((value) => !value)} aria-label="切换主题">{dark ? "日间" : "夜间"}</button>;
}
