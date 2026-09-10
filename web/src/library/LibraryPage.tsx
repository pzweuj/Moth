import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type BrowseResponse, type HomeDirectoryPreview, type HomeResponse, type HomeSeriesPreview, type PublicationSummary, type ScanStatus } from "../api";

type Theme = "light" | "dark";
type Props = { onLogout: () => Promise<void>; theme: Theme; onToggleTheme: () => void };

export function LibraryPage({ onLogout, theme, onToggleTheme }: Props) {
  const [params] = useSearchParams();
  const isBrowse = params.get("view") === "browse";
  const browsePath = params.get("path") ?? "";
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshScan = useCallback(async () => {
    try {
      const value = await api.scanStatus();
      setScanStatus(value);
      return value.scanning;
    } catch { return false; }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      if (isBrowse) setBrowse(await api.browse(browsePath));
      else setHome(await api.home());
      await refreshScan();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "书库加载失败"); }
    finally { setLoading(false); }
  }, [browsePath, isBrowse, refreshScan]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!scanStatus?.scanning) return;
    const timer = window.setInterval(() => { void refreshScan().then((running) => { if (!running) void load(); }); }, 500);
    return () => window.clearInterval(timer);
  }, [load, refreshScan, scanStatus?.scanning]);

  const scan = async () => {
    setError("");
    try { await api.scan(); await refreshScan(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "扫描失败"); }
  };

  const body = isBrowse && browse
    ? <BrowseView value={browse} loading={loading} />
    : <HomeView value={home} loading={loading} />;

  return <main className="home-shell">
    <nav className="home-nav"><Link className="wordmark" to="/">MOTH <span>个人书库</span></Link><div className="home-actions">{!isBrowse && <button className="quiet-button" type="button" onClick={() => void scan()} disabled={scanStatus?.scanning}>{scanStatus?.scanning ? "扫描中…" : "重新扫描"}</button>}<ThemeToggle theme={theme} onToggleTheme={onToggleTheme} /><button className="quiet-button" type="button" onClick={() => void onLogout()}>退出</button></div></nav>
    {!isBrowse && <ScanStatusView status={scanStatus} />}
    {error && <div className="form-error state-inline">{error}</div>}
    {body}
  </main>;
}

function HomeView({ value, loading }: { value: HomeResponse | null; loading: boolean }) {
  return <>
    <Section title="继续阅读" books={value?.continue_reading ?? []} loading={loading} />
    <section className="library-section directory-section"><div className="section-heading"><h2>目录</h2><Link className="section-link" to="/browse?view=browse&path=">浏览全部</Link></div>{loading ? <p className="shelf-hint">正在读取书库…</p> : value?.directories?.length ? <div className="directory-modules">{value.directories.map((directory) => <DirectoryModule directory={directory} key={directory.path} />)}</div> : <p className="shelf-hint">这里还没有目录。</p>}</section>
    {!loading && value?.hidden_directories?.length ? <details className="hidden-directories"><summary>更多书架</summary><div className="hidden-directory-list">{value.hidden_directories.map((directory) => <Link className="hidden-directory-link" key={directory.path} to={`/browse?view=browse&path=${encodeURIComponent(directory.path)}`}>{directory.name}</Link>)}</div></details> : null}
  </>;
}

function ScanStatusView({ status }: { status: ScanStatus | null }) {
  if (!status || (!status.scanning && status.total === 0 && status.errors === 0 && !status.message)) return null;
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

function BrowseView({ value, loading }: { value: BrowseResponse; loading: boolean }) {
  return <>
    <header className="library-head"><p className="eyebrow">目录</p><h1>{value.breadcrumbs.at(-1)?.name ?? "目录"}</h1></header>
    <div className="breadcrumbs">{value.breadcrumbs.map((crumb) => <Link key={crumb.path} to={`/browse?view=browse&path=${encodeURIComponent(crumb.path)}`}>{crumb.name}</Link>)}</div>
    <div className="directory-grid">{value.directories.map((directory) => <Link className="directory-card" key={directory.path} to={`/browse?view=browse&path=${encodeURIComponent(directory.path)}`}><strong>{directory.name}</strong><span>{directory.publication_count} 本</span></Link>)}</div>
    <BookGrid books={value.publications} loading={loading} />
  </>;
}

function Section({ title, books, loading }: { title: string; books: PublicationSummary[]; loading: boolean }) {
  if (!loading && books.length === 0) return null;
  return <section className="library-section"><div className="section-heading"><h2>{title}</h2></div><BookGrid books={books} loading={loading} /></section>;
}

function BookGrid({ books, loading }: { books: PublicationSummary[]; loading: boolean }) {
  if (loading) return <p className="shelf-hint">正在扫描书库…</p>;
  if (books.length === 0) return <p className="shelf-hint">这里还没有书。</p>;
  return <div className="book-grid">{books.map((book) => <Link className="book-card" to={`/reader/${book.id}`} key={book.id}><div className="book-cover">{book.cover_url ? <img src={book.cover_url} alt="" loading="lazy" /> : <span>{book.source_format.toUpperCase()}</span>}</div><div className="book-info"><h3>{book.title}</h3><p>{book.author || "未知作者"}</p><small>{Math.round(book.progress * 100)}% · {book.directory_path || "书库"}</small></div></Link>)}</div>;
}

function ThemeToggle({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return <button className="quiet-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "日间" : "夜间"}</button>;
}
