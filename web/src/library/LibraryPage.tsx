import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type BrowseResponse, type HomeResponse, type PublicationSummary, type ScanStatus } from "../api";

type Props = { onLogout: () => Promise<void> };

export function LibraryPage({ onLogout }: Props) {
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
      else {
        const [value, root] = await Promise.all([api.home(), api.browse("")]);
        setHome(value); setBrowse(root);
      }
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
    : <HomeView value={home} root={browse} loading={loading} status={scanStatus} onScan={() => void scan()} />;

  return <main className="home-shell">
    <nav className="home-nav"><Link className="wordmark" to="/">MOTH <span>个人书库</span></Link><div className="home-actions"><ThemeToggle /><button className="quiet-button" type="button" onClick={() => void onLogout()}>退出</button></div></nav>
    {error && <div className="form-error state-inline">{error}</div>}
    {body}
  </main>;
}

function HomeView({ value, root, loading, status, onScan }: { value: HomeResponse | null; root: BrowseResponse | null; loading: boolean; status: ScanStatus | null; onScan: () => void }) {
  const scanning = status?.scanning ?? false;
  return <>
    <header className="home-hero"><div><p className="eyebrow">FILESYSTEM FIRST / PERSONAL CORE</p><h1>回到故事里。</h1><p>书库目录就是你的分类，不复制、不改名、不接管原文件。</p></div></header>
    <Section title="继续阅读" books={value?.continue_reading ?? []} loading={loading} />
    <Section title="最近添加" books={value?.recently_added ?? []} loading={loading} />
    <section className="library-section"><div className="section-heading"><h2>目录</h2><div><button className="quiet-button" type="button" onClick={onScan} disabled={scanning}>{scanning ? "扫描中…" : "重新扫描"}</button><Link className="quiet-button" to="/browse?view=browse">打开目录</Link></div></div><p className="shelf-hint">{root ? `${root.publication_count} 本 · ${root.directory_count} 个目录` : "正在读取书库…"}</p></section>
    {status && (scanning || status.total > 0 || status.errors > 0 || status.message) && <p className="shelf-hint state-inline">{scanning ? "扫描进度" : "最近扫描"}：{status.processed} / {status.total}{status.errors ? `，${status.errors} 个错误` : ""}{status.message ? `，${status.message}` : ""}</p>}
  </>;
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

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("moth:theme") === "dark");
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; localStorage.setItem("moth:theme", dark ? "dark" : "light"); }, [dark]);
  return <button className="quiet-button" type="button" onClick={() => setDark((value) => !value)} aria-label="切换主题">{dark ? "日间" : "夜间"}</button>;
}
