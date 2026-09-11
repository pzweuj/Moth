import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type BrowseResponse, type HomeDirectoryPreview, type HomeResponse, type HomeSeriesPreview, type PublicationSummary, type ScanStatus, type SearchDirectoryItem, type SearchResponse } from "../api";
import { useLibraryData, type LibraryPageCache } from "./useLibraryData";

type Theme = "light" | "dark";
type Props = { cache: LibraryPageCache; onLogout: () => Promise<void>; theme: Theme; onToggleTheme: () => void };

export function LibraryPage({ cache, onLogout, theme, onToggleTheme }: Props) {
  const [params, setParams] = useSearchParams();
  const isBrowse = params.get("view") === "browse";
  const browsePath = params.get("path") ?? "";
  const searchQuery = (params.get("q") ?? "").trim();
  const includeHidden = params.get("include_hidden") === "1" || params.get("include_hidden") === "true" || params.get("hidden") === "1";
  const { home, browse, loading, error: loadError, refresh: refreshLibrary } = useLibraryData(cache, isBrowse, browsePath);
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchMore, setSearchMore] = useState<"shelves" | "series" | "books" | "">("");
  const [searchRequestVersion, setSearchRequestVersion] = useState(0);
  const searchImmediateRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [error, setError] = useState("");
  const [scanSubmitting, setScanSubmitting] = useState(false);

  const refreshScan = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.scanStatus(signal);
      if (signal?.aborted) return null;
      setScanStatus(value);
      return value;
    } catch { return null; }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshScan(controller.signal);
    return () => controller.abort();
  }, [refreshScan]);

  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    if (!searchQuery) {
      searchImmediateRef.current = false;
      setSearchResults(null);
      setSearchError("");
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    setSearchResults(null);
    setSearchLoading(true);
    setSearchError("");
    setSearchMore("");
    const immediate = searchImmediateRef.current;
    searchImmediateRef.current = false;
    const timer = window.setTimeout(() => {
      void api.search(searchQuery, includeHidden, "all", 0, 20, controller.signal)
        .then((value) => { if (!controller.signal.aborted && generation === searchGenerationRef.current) setSearchResults(value); })
        .catch((reason) => {
          if (!controller.signal.aborted && generation === searchGenerationRef.current) setSearchError(reason instanceof Error ? reason.message : "搜索失败");
        })
        .finally(() => { if (!controller.signal.aborted && generation === searchGenerationRef.current) setSearchLoading(false); });
    }, immediate ? 0 : 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      loadMoreControllerRef.current?.abort();
    };
  }, [includeHidden, searchQuery, searchRequestVersion]);

  useEffect(() => {
    if (!scanStatus?.scanning) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      const status = await refreshScan(controller.signal);
      if (controller.signal.aborted) return;
      if (status && !status.scanning) {
        cache.clear();
        refreshLibrary();
        setSearchRequestVersion(value => value + 1);
      } else timer = window.setTimeout(() => void poll(), 500);
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [cache, refreshLibrary, refreshScan, scanStatus?.scanning]);

  const scan = async () => {
    setError("");
    setScanSubmitting(true);
    try {
      await api.scan();
      const status = await refreshScan();
      // A small library can finish scanning before the first status response.
      if (status && !status.scanning) {
        cache.clear();
        refreshLibrary();
        setSearchRequestVersion(value => value + 1);
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "扫描失败"); }
    finally { setScanSubmitting(false); }
  };

  const updateSearch = (value: string, hidden = includeHidden) => {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set("q", value);
    else next.delete("q");
    if (hidden) next.set("include_hidden", "1");
    else next.delete("include_hidden");
    next.delete("hidden");
    setParams(next, { replace: true });
  };

  const loadMoreSearch = useCallback(async (kind: "shelves" | "series" | "books") => {
    if (!searchResults || searchMore || !searchQuery) return;
    const group = searchResults[kind];
    if (!group.has_more) return;
    setSearchMore(kind);
    const generation = searchGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    try {
      const next = await api.search(searchQuery, includeHidden, kind, group.items.length, 20, controller.signal);
      if (generation !== searchGenerationRef.current || controller.signal.aborted) return;
      setSearchResults((current) => current ? {
        shelves: kind === "shelves" ? { ...current.shelves, items: [...current.shelves.items, ...next.shelves.items], has_more: next.shelves.has_more } : current.shelves,
        series: kind === "series" ? { ...current.series, items: [...current.series.items, ...next.series.items], has_more: next.series.has_more } : current.series,
        books: kind === "books" ? { ...current.books, items: [...current.books.items, ...next.books.items], has_more: next.books.has_more } : current.books,
      } : current);
    } catch (reason) {
      if (!controller.signal.aborted && generation === searchGenerationRef.current) setSearchError(reason instanceof Error ? reason.message : "搜索结果加载失败");
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = null;
      if (generation === searchGenerationRef.current) setSearchMore("");
    }
  }, [includeHidden, searchMore, searchQuery, searchResults]);

  const submitSearch = () => {
    searchImmediateRef.current = true;
    setSearchRequestVersion((value) => value + 1);
  };

  const body = searchQuery
    ? <SearchView query={searchQuery} results={searchResults} loading={searchLoading} error={searchError} loadingKind={searchMore} onRetry={submitSearch} onLoadMore={(kind) => void loadMoreSearch(kind)} />
    : isBrowse
      ? <BrowseView value={browse} loading={loading} />
      : <HomeView value={home} loading={loading} />;

  return <main className="home-shell">
    <header className="library-header">
      <nav className="home-nav"><Link className="wordmark" to="/">MOTH <span>个人书库</span></Link><div className="home-actions">{!isBrowse && <button className="quiet-button" type="button" onClick={() => void scan()} disabled={scanSubmitting || scanStatus?.scanning}>{scanSubmitting || scanStatus?.scanning ? "扫描中…" : "重新扫描"}</button>}<ThemeToggle theme={theme} onToggleTheme={onToggleTheme} /><button className="quiet-button" type="button" onClick={() => void onLogout()}>退出</button></div></nav>
      <LibrarySearch query={params.get("q") ?? ""} includeHidden={includeHidden} onQueryChange={(value) => updateSearch(value)} onIncludeHiddenChange={(value) => updateSearch(params.get("q") ?? "", value)} onSubmit={submitSearch} />
    </header>
    {!isBrowse && <ScanStatusView status={scanStatus} />}
    {error && <div className="form-error state-inline">{error}</div>}
    {loadError && <div className="form-error state-inline" role="alert">{loadError}<button className="quiet-button" type="button" onClick={refreshLibrary}>重试</button></div>}
    <div className="library-body" aria-busy={searchQuery ? searchLoading : loading}>{body}</div>
  </main>;
}

function HomeView({ value, loading }: { value: HomeResponse | null; loading: boolean }) {
  if (!value) return null;
  return <>
    <Section title="继续阅读" books={value?.continue_reading ?? []} loading={loading} />
    <section className="library-section directory-section"><div className="section-heading"><h2>目录</h2><Link className="section-link" to="/browse?view=browse&path=">浏览全部</Link></div>{value.directories.length ? <div className="directory-modules">{value.directories.map((directory) => <DirectoryModule directory={directory} key={directory.path} />)}</div> : <p className="shelf-hint">这里还没有目录。</p>}</section>
    {!loading && value?.hidden_directories?.length ? <details className="hidden-directories"><summary>更多书架</summary><div className="hidden-directory-list">{value.hidden_directories.map((directory) => <Link className="hidden-directory-link" key={directory.path} to={`/browse?view=browse&path=${encodeURIComponent(directory.path)}`}>{directory.name}</Link>)}</div></details> : null}
  </>;
}

function ScanStatusView({ status }: { status: ScanStatus | null }) {
  if (!status || (!status.scanning && status.errors === 0 && !status.message)) return null;
  const progress = status.discovery_complete ? `${status.processed} / ${status.total}` : `已处理 ${status.processed} 本`;
  return <div className="scan-status" role="status"><span>{status.scanning ? "扫描进度" : "最近扫描"}</span>：{progress}{status.errors ? `，${status.errors} 个错误` : ""}{status.message ? `，${status.message}` : ""}</div>;
}

function DirectoryModule({ directory }: { directory: HomeDirectoryPreview }) {
  return <section className="directory-module"><div className="directory-module-heading"><Link to={`/browse?view=browse&path=${encodeURIComponent(directory.path)}`}><h3>{directory.name}</h3></Link><span>{directory.series.length ? "系列" : "暂无系列"}</span></div>{directory.series.length > 0 && <div className="series-grid">{directory.series.map((series) => <SeriesCard series={series} key={series.path} />)}</div>}</section>;
}

function SeriesCard({ series }: { series: HomeSeriesPreview }) {
  const book = series.representative;
  return <Link className="series-card" to={`/browse?view=browse&path=${encodeURIComponent(series.path)}`}><div className="series-cover">{book?.cover_url ? <img src={book.cover_url} alt="" loading="lazy" /> : <span>{book?.source_format.toUpperCase() ?? "系列"}</span>}</div><div className="series-info"><h4>{series.name}</h4><p>{series.publication_count} 本</p></div></Link>;
}

function BrowseView({ value, loading }: { value: BrowseResponse | null; loading: boolean }) {
  if (!value) return null;
  return <>
    <header className="library-head"><p className="eyebrow">目录</p><h1>{value.breadcrumbs.at(-1)?.name ?? "目录"}</h1></header>
    <div className="breadcrumbs">{value.breadcrumbs.map((crumb) => <Link key={crumb.path} to={`/browse?view=browse&path=${encodeURIComponent(crumb.path)}`}>{crumb.name}</Link>)}</div>
    <div className="directory-grid">{value.directories.map((directory) => <Link className="directory-card" key={directory.path} to={`/browse?view=browse&path=${encodeURIComponent(directory.path)}`}><strong>{directory.name}</strong><span>{value.path === "" ? `${directory.child_directory_count} 个系列` : `${directory.publication_count} 本`}</span></Link>)}</div>
    <BookGrid books={value.publications} loading={loading} showEmpty={false} />
  </>;
}

function Section({ title, books, loading }: { title: string; books: PublicationSummary[]; loading: boolean }) {
  if (!loading && books.length === 0) return null;
  return <section className="library-section"><div className="section-heading"><h2>{title}</h2></div><BookGrid books={books} loading={loading} /></section>;
}

function BookGrid({ books, loading, showEmpty = true }: { books: PublicationSummary[]; loading: boolean; showEmpty?: boolean }) {
  if (loading) return null;
  if (books.length === 0) return showEmpty ? <p className="shelf-hint">这里还没有书。</p> : null;
  return <div className="book-grid">{books.map((book) => <Link className="book-card" to={`/reader/${book.id}`} key={book.id}><div className="book-cover">{book.cover_url ? <img src={book.cover_url} alt="" loading="lazy" /> : <span>{book.source_format.toUpperCase()}</span>}</div><div className="book-info"><h3>{book.title}</h3><p>{book.author || "未知作者"}</p><small>{Math.round(book.progress * 100)}% · {book.directory_path || "书库"}</small></div></Link>)}</div>;
}

function LibrarySearch({ query, includeHidden, onQueryChange, onIncludeHiddenChange, onSubmit }: { query: string; includeHidden: boolean; onQueryChange: (value: string) => void; onIncludeHiddenChange: (value: boolean) => void; onSubmit: () => void }) {
  const [composing, setComposing] = useState(false);
  return <form className="library-search" role="search" onSubmit={(event) => { event.preventDefault(); const native = event.nativeEvent as Event & { isComposing?: boolean }; if (!composing && !native.isComposing) onSubmit(); }}>
    <input type="search" aria-label="搜索书架、系列或书籍名称" placeholder="搜索书架、系列或书籍名称" value={query} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); onQueryChange(event.currentTarget.value); }} onChange={(event) => { if (!composing && !(event.nativeEvent as InputEvent).isComposing) onQueryChange(event.target.value); }} />
    <label><input type="checkbox" checked={includeHidden} onChange={(event) => onIncludeHiddenChange(event.target.checked)} />包含隐藏书架</label>
  </form>;
}

function SearchView({ query, results, loading, error, loadingKind, onRetry, onLoadMore }: { query: string; results: SearchResponse | null; loading: boolean; error: string; loadingKind: "shelves" | "series" | "books" | ""; onRetry: () => void; onLoadMore: (kind: "shelves" | "series" | "books") => void }) {
  const hasResults = !!results && (results.shelves.items.length > 0 || results.series.items.length > 0 || results.books.items.length > 0);
  return <section className="search-results">
    <header className="library-head"><p className="eyebrow">搜索</p><h1>“{query}”</h1></header>
    {loading && <p className="shelf-hint">正在搜索…</p>}
    {!loading && error && <div className="search-error"><p>{error}</p><button className="quiet-button" type="button" onClick={onRetry}>重试</button></div>}
    {!loading && !error && results && !hasResults && <p className="shelf-hint">未找到匹配的书架、系列或书籍</p>}
    {!loading && !error && results && <>
      <SearchDirectoryGroup title="书架" kind="shelves" group={results.shelves} loadingKind={loadingKind} onLoadMore={onLoadMore} />
      <SearchDirectoryGroup title="系列" kind="series" group={results.series} loadingKind={loadingKind} onLoadMore={onLoadMore} />
      <SearchBookGroup group={results.books} loadingKind={loadingKind} onLoadMore={onLoadMore} />
    </>}
  </section>;
}

function SearchDirectoryGroup({ title, kind, group, loadingKind, onLoadMore }: { title: string; kind: "shelves" | "series"; group: { items: SearchDirectoryItem[]; total: number; has_more: boolean }; loadingKind: "shelves" | "series" | "books" | ""; onLoadMore: (kind: "shelves" | "series" | "books") => void }) {
  if (group.items.length === 0) return null;
  return <section className="search-group"><div className="section-heading"><h2>{title}</h2><span className="search-count">{group.total}</span></div><div className="search-directory-list">{group.items.map((item) => <Link className="search-directory-item" to={`/browse?view=browse&path=${encodeURIComponent(item.path)}`} key={item.path}><strong>{item.name}</strong><small>{item.path || "书库"} · {kind === "shelves" ? `${item.child_directory_count} 个系列` : `${item.publication_count} 本`}</small></Link>)}</div>{group.has_more && <button className="quiet-button search-more" type="button" disabled={loadingKind !== ""} onClick={() => onLoadMore(kind)}>{loadingKind === kind ? "加载中…" : "加载更多"}</button>}</section>;
}

function SearchBookGroup({ group, loadingKind, onLoadMore }: { group: { items: PublicationSummary[]; total: number; has_more: boolean }; loadingKind: "shelves" | "series" | "books" | ""; onLoadMore: (kind: "shelves" | "series" | "books") => void }) {
  if (group.items.length === 0) return null;
  return <section className="search-group"><div className="section-heading"><h2>书籍</h2><span className="search-count">{group.total}</span></div><BookGrid books={group.items} loading={false} showEmpty={false} />{group.has_more && <button className="quiet-button search-more" type="button" disabled={loadingKind !== ""} onClick={() => onLoadMore("books")}>{loadingKind === "books" ? "加载中…" : "加载更多"}</button>}</section>;
}

function ThemeToggle({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return <button className="quiet-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "日间" : "夜间"}</button>;
}
