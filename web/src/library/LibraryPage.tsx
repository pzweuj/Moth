import { useMemo, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BookSummary, type SectionSummary, type SessionState } from "../api";
import { useOfflineBook } from "../offline/useOfflineBook";
import { useUi, translateError } from "../i18n";
import { useDialog } from "../ui/DialogProvider";
import { AppearanceControls } from "../ui/AppearanceControls";

export type LibraryReturnState = {
  fromReader: true;
  search: string;
  format: "all" | BookSummary["format"];
  searchAll: boolean;
};

export type ReaderReturnLocation = {
  pathname: string;
  state: LibraryReturnState;
};

function matchesBook(
  book: BookSummary,
  query: string,
  format: "all" | BookSummary["format"],
): boolean {
  const matchesFormat = format === "all" || book.format === format;
  const matchesSearch = !query
    || book.title.toLowerCase().includes(query)
    || (book.author?.toLowerCase().includes(query) ?? false);
  return matchesFormat && matchesSearch;
}

export function LibraryPage({ session }: { session?: SessionState }) {
  const { t } = useUi();
  const dialog = useDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { sectionId: sectionParam, seriesId: seriesParam } = useParams();
  const sectionId = sectionParam !== undefined ? Number(sectionParam) : undefined;
  const seriesId = seriesParam !== undefined ? Number(seriesParam) : undefined;
  const isAllView = location.pathname === "/all";
  const locationState = location.state as Partial<LibraryReturnState> | null;
  const returnedFromReader = locationState?.fromReader === true;
  const initialSearch = returnedFromReader && typeof locationState?.search === "string" ? locationState.search : "";
  const initialFormat = returnedFromReader
    && (locationState?.format === "all" || locationState?.format === "epub" || locationState?.format === "txt" || locationState?.format === "cbz" || locationState?.format === "mobi")
    ? locationState.format
    : "all";
  const [search, setSearch] = useState(initialSearch);
  const [format, setFormat] = useState<"all" | BookSummary["format"]>(initialFormat);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [moveTarget, setMoveTarget] = useState("");
  const [seriesTarget, setSeriesTarget] = useState("");
  const [searchAll, setSearchAll] = useState(returnedFromReader && locationState?.searchAll === true);

  const books = useQuery<BookSummary[]>({ queryKey: ["books"], queryFn: () => api.getBooks(), networkMode: "always" });
  const sections = useQuery<SectionSummary[]>({ queryKey: ["sections"], queryFn: api.getSections, networkMode: "always" });
  const scan = useMutation({
    mutationFn: api.scanLibrary,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scan-status"] });
      void queryClient.invalidateQueries({ queryKey: ["sections"] });
    },
  });
  const scanStatus = useQuery({
    queryKey: ["scan-status"],
    queryFn: api.getScanStatus,
    refetchInterval: (query) => (query.state.data?.scanning ? 1500 : false),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: async () => {
      // Logout clears the durable account cache in api.logout. Remove the
      // corresponding in-memory queries as well so a later login (or a
      // different server instance at the same origin) cannot briefly render
      // the previous shelf or book detail while it refetches.
      await queryClient.cancelQueries({
        predicate: (query) => query.queryKey[0] !== "setup-status",
      });
      queryClient.removeQueries({ queryKey: ["books"] });
      queryClient.removeQueries({ queryKey: ["sections"] });
      queryClient.removeQueries({ queryKey: ["book"] });
      queryClient.removeQueries({ queryKey: ["scan-status"] });
      queryClient.setQueryData<SessionState>(["session"], {
        authenticated: false,
      });
      navigate("/login", { replace: true });
    },
  });

  const requestLogout = async () => {
    if (await api.hasPendingProgress()
      && !await dialog.confirm(t("Some reading progress has not synced. Sign out and clear this device anyway?"), t("Sign out"))) {
      return;
    }
    logout.mutate();
  };

  useEffect(() => {
    if (!scanStatus.data?.scanning) {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      void queryClient.invalidateQueries({ queryKey: ["sections"] });
    }
  }, [scanStatus.data?.scanning, queryClient]);

  useEffect(() => {
    setSelectedIds([]);
    setMoveTarget("");
    setSeriesTarget("");
    if (!returnedFromReader) setSearchAll(false);
  }, [isAllView, returnedFromReader, sectionId, seriesId]);

  // A reader route is a separate page, so restore the view controls from the
  // navigation state supplied by the book card when returning to the shelf.
  useEffect(() => {
    if (!returnedFromReader) return;
    setSearch(initialSearch);
    setFormat(initialFormat);
    setSearchAll(locationState?.searchAll === true);
  // `location.key` changes for each navigation while the state values remain
  // stable during typing on the shelf.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const allSections = sections.data ?? [];
  const currentSection = sectionId !== undefined ? allSections.find((section) => section.id === sectionId) : undefined;
  const currentSeries = seriesId !== undefined
    ? allSections.flatMap((section) => section.series).find((series) => series.id === seriesId)
    : undefined;
  const sectionName = (section: SectionSummary) => section.is_system ? t("Unclassified") : section.name;
  const currentSectionName = currentSection ? sectionName(currentSection) : undefined;
  const query = search.trim().toLowerCase();
  const scopeBooks = useMemo(() => {
    if (searchAll || isAllView || (sectionId === undefined && seriesId === undefined)) return books.data ?? [];
    if (currentSeries) return currentSeries.books;
    if (currentSection) return [
      ...(query ? currentSection.series.flatMap((series) => series.books) : []),
      ...currentSection.books,
    ];
    return books.data ?? [];
  }, [books.data, currentSection, currentSeries, isAllView, query, searchAll, sectionId, seriesId]);

  const refreshOrganization = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["books"] }),
      queryClient.invalidateQueries({ queryKey: ["sections"] }),
    ]);
  };
  const createSection = async () => {
    if (session?.offline) return;
    const name = await dialog.prompt(t("Enter a section name"), "", t("New section"));
    if (!name?.trim()) return;
    try {
      await api.createSection(name);
      await refreshOrganization();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not create section"));
    }
  };
  const renameSection = async () => {
    if (!currentSection || currentSection.is_system || session?.offline) return;
    const name = await dialog.prompt(t("Enter a section name"), currentSection.name, t("Rename section"));
    if (!name?.trim() || name.trim() === currentSection.name) return;
    try {
      await api.updateSection(currentSection.id, { name });
      await refreshOrganization();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not rename section"));
    }
  };
  const removeSection = async () => {
    if (!currentSection || currentSection.is_system || session?.offline) return;
    if (!await dialog.confirm(t("Move {{count}} books to Unclassified and delete {{name}}?", { count: sectionCardBooks(currentSection), name: currentSection.name }), t("Delete section"))) return;
    try {
      await api.deleteSection(currentSection.id);
      await refreshOrganization();
      navigate("/");
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not delete section"));
    }
  };
  const createSeries = async () => {
    if (!currentSection || session?.offline) return;
    const name = await dialog.prompt(t("Enter a series name"), "", t("New series"));
    if (!name?.trim()) return;
    try {
      await api.createSeries(name, currentSection.id);
      await refreshOrganization();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not create series"));
    }
  };
  const renameSeries = async () => {
    if (!currentSeries || session?.offline) return;
    const name = await dialog.prompt(t("Enter a series name"), currentSeries.name, t("Rename series"));
    if (!name?.trim() || name.trim() === currentSeries.name) return;
    try {
      await api.updateSeries(currentSeries.id, { name });
      await refreshOrganization();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not rename series"));
    }
  };
  const removeSeries = async () => {
    if (!currentSeries || session?.offline) return;
    if (!await dialog.confirm(t("Remove the {{name}} series ({{count}} books)? Books will stay in its section.", { name: currentSeries.name, count: currentSeries.book_count }), t("Remove series"))) return;
    try {
      await api.deleteSeries(currentSeries.id);
      await refreshOrganization();
      navigate(`/section/${currentSeries.section_id}`);
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not delete series"));
    }
  };
  const moveSeries = async () => {
    if (!currentSeries || !seriesTarget || session?.offline) return;
    const target = Number(seriesTarget);
    try {
      await api.updateSeries(currentSeries.id, { section_id: target });
      await refreshOrganization();
      navigate(`/section/${target}`);
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not move series"));
    }
  };
  const organize = useMutation({
    mutationFn: async () => {
      const [kind, value] = moveTarget.split(":");
      if (!selectedIds.length || !value || (kind !== "section" && kind !== "series")) throw new Error("Choose a destination first");
      return api.organizeBooks(selectedIds, kind === "section" ? { section_id: Number(value) } : { series_id: Number(value) });
    },
    onSuccess: async () => {
      setSelectedIds([]);
      setMoveTarget("");
      await refreshOrganization();
    },
    onError: (error: Error) => { void dialog.alert(translateError(error, t), t("Could not move books")); },
  });
  const removeMissing = useMutation({
    mutationFn: (id: number) => api.deleteMissingBook(id),
    onSuccess: refreshOrganization,
    onError: (error: Error) => { void dialog.alert(translateError(error, t), t("Could not remove record")); },
  });
  const reorderSection = async (id: number, direction: -1 | 1) => {
    const ordered = allSections.filter((section) => !section.is_system);
    const index = ordered.findIndex((section) => section.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length || session?.offline) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    try {
      await api.reorderSections(ordered.map((section) => section.id));
      await refreshOrganization();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not reorder sections"));
    }
  };

  const scanning = scanStatus.data?.scanning ?? false;
  const filtered = useMemo(
    () => scopeBooks.filter((book) => matchesBook(book, query, format)),
    [format, query, scopeBooks],
  );
  const directBooks = currentSection && !currentSeries && !searchAll
    ? filtered.filter((book) => book.series_id == null)
    : filtered;
  const matchingSeries = currentSection && !currentSeries && !searchAll
    ? currentSection.series
      .map((series) => ({
        ...series,
        books: series.books.filter((book) => matchesBook(book, query, format)),
      }))
      .filter((series) => series.books.length > 0)
    : [];
  const hasVisibleContent = directBooks.length > 0 || matchingSeries.length > 0;

  const hasOrganizedBooks = allSections.some((section) => section.book_count > 0);
  const toggleSelected = (id: number) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };
  const sectionCardBooks = (section: SectionSummary) => section.series.reduce((total, series) => total + series.book_count, 0) + section.books.length;
  const readerReturn: ReaderReturnLocation = {
    pathname: location.pathname,
    state: { fromReader: true, search, format, searchAll },
  };

  return (
    <main className="home-shell">
      <div className="grain" aria-hidden="true" />
      <header className="home-nav">
        <span className="wordmark">Moth <span>/</span> {t("personal library")}</span>
        <div className="home-actions">
          <AppearanceControls compact />
          {session?.offline && (
            <button className="quiet-button" type="button" onClick={() => navigate("/login")}>
              {t("Sign in to sync")}
            </button>
          )}
          <button
            className="quiet-button"
            type="button"
            onClick={() => scan.mutate()}
            disabled={scan.isPending || scanning}
          >
            {scanning ? t("Scanning…") : scan.isPending ? t("Starting…") : t("Rescan library")}
          </button>
          <button className="quiet-button" type="button" onClick={() => void createSection()} disabled={session?.offline}>
            {t("New section")}
          </button>
          <button className="quiet-button" type="button" onClick={() => void requestLogout()} disabled={logout.isPending}>
            {logout.isPending ? t("Leaving…") : <>{t("Sign out")}<span className="sr-only"> Sign out</span></>}
          </button>
        </div>
      </header>

      <section className="library-head">
        <p className="eyebrow">{t("Good to see you, {{name}}", { name: session?.username ?? "" })}<span className="sr-only"> Good to see you, {session?.username ?? ""}</span></p>
        <h1>{currentSeries?.name ?? currentSectionName ?? (isAllView ? t("All books") : t("Your library"))}{!currentSeries && !currentSection && <span className="sr-only"> {isAllView ? "All books" : "Your library"}</span>}</h1>
        <p className="lede">{currentSeries ? t("{{count}} books in this series.", { count: currentSeries.book_count }) : currentSection ? t("{{count}} books in this section.", { count: sectionCardBooks(currentSection) }) : t("Books rest quietly here, ready when you are.")}</p>
      </section>

      <nav className="library-shortcuts" aria-label={t("Library shortcuts")}>
        <Link to="/all">{t("All books")}</Link>
        {allSections.find((section) => section.is_system) && (
          <Link to={`/section/${allSections.find((section) => section.is_system)!.id}`}>
            {t("Unclassified")}
          </Link>
        )}
      </nav>
      <nav className="library-breadcrumbs" aria-label={t("Library location")}>
        <Link to="/all">{t("All books")}</Link>
        {currentSection && <><span aria-hidden="true">/</span><Link to={`/section/${currentSection.id}`}>{currentSectionName}</Link></>}
        {currentSeries && <><span aria-hidden="true">/</span><span>{currentSeries.name}</span></>}
      </nav>

      {!session?.offline && currentSection && !currentSeries && (
        <div className="organization-actions">
          <button className="quiet-button" type="button" onClick={() => void createSeries()}>{t("New series")}</button>
          {!currentSection.is_system && <>
            <button className="quiet-button" type="button" onClick={() => void renameSection()}>{t("Rename section")}</button>
            <button className="quiet-button" type="button" onClick={() => void removeSection()}>{t("Delete section")}</button>
          </>}
        </div>
      )}
      {!session?.offline && currentSeries && (
        <div className="organization-actions">
          <button className="quiet-button" type="button" onClick={() => void renameSeries()}>{t("Rename series")}</button>
          <select className="organization-select" aria-label={t("Move series to section")} value={seriesTarget} onChange={(event) => setSeriesTarget(event.target.value)}>
            <option value="">{t("Move series to…")}</option>
            {allSections.filter((section) => section.id !== currentSeries.section_id).map((section) => (
              <option key={section.id} value={section.id}>{sectionName(section)}</option>
            ))}
          </select>
          <button className="quiet-button" type="button" onClick={() => void moveSeries()} disabled={!seriesTarget}>{t("Move")}</button>
          <button className="quiet-button" type="button" onClick={() => void removeSeries()}>{t("Remove series")}</button>
        </div>
      )}

      <div className="library-toolbar">
        <input
          className="search-input"
          type="search"
          placeholder={t("Search title or author…")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("Search library")}
        />
        <div className="format-filter" role="group" aria-label={t("Filter by format")}>
          {(["all", "epub", "txt", "cbz", "mobi"] as const).map((entry) => (
            <button
              key={entry}
              className={`format-chip ${format === entry ? "is-active" : ""}`}
              type="button"
              onClick={() => setFormat(entry)}
            >
              {entry === "all" ? t("All") : entry.toUpperCase()}
            </button>
          ))}
        </div>
        {(currentSection || currentSeries) && (
          <button className={`format-chip ${searchAll ? "is-active" : ""}`} type="button" onClick={() => setSearchAll((value) => !value)}>
            {searchAll ? t("This location") : t("Search all books")}
          </button>
        )}
        <OfflineStorageStatus />
      </div>

      {selectedIds.length > 0 && !session?.offline && (
        <div className="organization-toolbar" role="region" aria-label={t("Organize selected books")}>
          <span>{selectedIds.length} {t("selected")}</span>
          <select aria-label={t("Move selected books")} value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
            <option value="">{t("Move to…")}</option>
            {allSections.map((section) => (
              <option key={`section-${section.id}`} value={`section:${section.id}`}>{sectionName(section)}</option>
            ))}
            {allSections.flatMap((section) => section.series.map((series) => (
              <option key={`series-${series.id}`} value={`series:${series.id}`}>{sectionName(section)} / {series.name}</option>
            )))}
          </select>
          <button className="primary-button compact-button" type="button" onClick={() => organize.mutate()} disabled={organize.isPending || !moveTarget}>
            {organize.isPending ? t("Moving…") : t("Move")}
          </button>
          <button className="quiet-button" type="button" onClick={() => setSelectedIds([])}>{t("Clear selection")}</button>
        </div>
      )}

      {scanning && (
        <p className="scan-note" role="status">
          {t("Indexing library…")} {scanStatus.data?.processed ?? 0} / {scanStatus.data?.total ?? 0}
        </p>
      )}

      {books.isPending || sections.isPending ? (
        <p className="scan-note">{t("Opening your library…")}</p>
      ) : sectionId === undefined && seriesId === undefined && !isAllView && hasOrganizedBooks && !query && format === "all" ? (
        <>
          <ul className="section-grid">
            {allSections.map((section) => (
              <li key={section.id} className="section-card">
                <Link to={`/section/${section.id}`}>
                  <span className="eyebrow">{section.is_system ? t("System section") : t("Section")}</span>
                  <h2>{sectionName(section)}</h2>
                  <p>{section.series.length} {t("series")} · {sectionCardBooks(section)} {t("books")}</p>
                </Link>
                {!section.is_system && !session?.offline && (
                  <div className="section-order-actions">
                    <button className="quiet-button" type="button" onClick={() => void reorderSection(section.id, -1)}>{t("Up")}</button>
                    <button className="quiet-button" type="button" onClick={() => void reorderSection(section.id, 1)}>{t("Down")}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="shelf-hint">{t("Open a section to browse its series and independent books.")}</p>
        </>
      ) : !hasVisibleContent ? (
        <section className="empty-library">
          <h2>{books.data && books.data.length === 0 ? t("Nothing here yet.") : t("Nothing matches.")}</h2>
          <p>
            {books.data && books.data.length === 0
              ? t("Add EPUB, TXT, CBZ, or MOBI books to the library directory, then scan.")
              : t("Try a different search or format filter.")}
          </p>
          {books.data && books.data.length === 0 && (
            <button
              className="primary-button compact-button"
              type="button"
              onClick={() => scan.mutate()}
              disabled={scan.isPending || scanning}
            >
              {t("Scan for books")}
            </button>
          )}
        </section>
      ) : (
        <>
          {currentSection && !currentSeries && !searchAll && matchingSeries.length > 0 && (
            <ul className="series-grid">
              {matchingSeries.map((series) => (
                <li key={series.id} className="series-card">
                  <Link to={`/series/${series.id}`}>
                    <div className="series-cover">
                      {series.cover_url && !session?.offline ? <img src={series.cover_url} alt="" loading="lazy" /> : <span aria-hidden="true">{t("BOOKS")}</span>}
                    </div>
                    <span className="eyebrow">{t("Series")}</span>
                    <h2>{series.name}</h2>
                    <p>{series.books.length} {t("books")}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <ul className="book-grid">
            {directBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                selected={selectedIds.includes(book.id)}
                onToggle={() => toggleSelected(book.id)}
                onRemoveMissing={() => removeMissing.mutate(book.id)}
                readerReturn={readerReturn}
                sectionLabel={book.section_id === undefined ? book.section_name : allSections.find((section) => section.id === book.section_id)?.is_system ? t("Unclassified") : book.section_name}
                showPath={Boolean(searchAll || query || (sectionId === undefined && seriesId === undefined))}
              />
            ))}
          </ul>
          {currentSeries && currentSeries.books.length > 1 && !session?.offline && (
            <SeriesOrderButtons series={currentSeries} onSaved={refreshOrganization} />
          )}
        </>
      )}
    </main>
  );
}

function OfflineStorageStatus() {
  const { t } = useUi();
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [quotaWarning, setQuotaWarning] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!storage?.estimate) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await storage.estimate();
        if (!cancelled) setEstimate(next);
      } catch {
        // Storage estimates are optional and may be denied in private mode.
      }
    };
    void refresh();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onStorage = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type === "quota") setQuotaWarning(true);
      if (type === "cleared") {
        setQuotaWarning(false);
        const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
        if (storage?.estimate) void storage.estimate().then(setEstimate).catch(() => undefined);
      }
    };
    window.addEventListener("moth-offline-storage", onStorage);
    return () => window.removeEventListener("moth-offline-storage", onStorage);
  }, []);

  if (quotaWarning) {
    return (
      <span className="storage-note storage-warning" role="status">
        {t("Offline storage is full")} · <button className="inline-action" type="button" disabled={clearing} onClick={() => {
          setClearing(true);
          void api.clearOfflineContent().finally(() => setClearing(false));
        }}>{clearing ? t("clearing…") : t("clear cached content")}</button>
      </span>
    );
  }
  if (!estimate?.quota) {
    return <button className="storage-note storage-action" type="button" disabled={clearing} onClick={() => {
      setClearing(true);
      void api.clearOfflineContent().finally(() => setClearing(false));
    }}>{clearing ? t("clearing…") : t("Clear cached content")}</button>;
  }
  return (
    <span className="storage-note" title={t("Approximate browser storage usage")}>
      {t("Offline storage")} {formatBytes(estimate.usage ?? 0)} / {formatBytes(estimate.quota)}
      <button className="inline-action" type="button" disabled={clearing} onClick={() => {
        setClearing(true);
        void api.clearOfflineContent().finally(() => setClearing(false));
      }}>{clearing ? t("clearing…") : t("clear")}</button>
    </span>
  );
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function BookCard({
  book,
  selected = false,
  onToggle,
  onRemoveMissing,
  readerReturn,
  sectionLabel,
  showPath = false,
}: {
  book: BookSummary;
  selected?: boolean;
  onToggle?: () => void;
  onRemoveMissing?: () => void;
  readerReturn?: ReaderReturnLocation;
  sectionLabel?: string;
  showPath?: boolean;
}) {
  const { t } = useUi();
  const dialog = useDialog();
  const offline = useOfflineBook(book);
  const isOnline = typeof navigator === "undefined" || navigator.onLine;
  const coverUrl = offline.state === "partial"
    ? offline.coverUrl ?? (isOnline ? book.cover_url : undefined)
    : book.cover_url;
  const card = (
    <>
      <div className="book-cover">
        {book.has_cover && coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" />
        ) : (
          <div className="book-cover-placeholder" aria-hidden="true">
            <span className="cover-format">{book.format.toUpperCase()}</span>
          </div>
        )}
        {book.parse_status === "error" && (
          <span className="cover-error">{t("Unreadable")}</span>
        )}
        {book.missing && <span className="cover-error">{t("Missing file")}</span>}
        {book.parse_status === "ok" && book.percent > 0 && (
          <div className="progress-rail">
            <span style={{ width: `${Math.min(100, book.percent)}%` }} />
          </div>
        )}
      </div>
      <div className="book-info">
        <h3>{book.title}</h3>
        {book.author && <p className="book-author">{book.author}</p>}
        <div className="book-meta">
          <span className="format-badge">{book.format}</span>
          {book.parse_status === "ok" && book.percent > 0 && (
            <span className="book-progress">{Math.round(book.percent)}%</span>
          )}
        </div>
        {showPath && (book.series_name || sectionLabel || book.section_name) && (
          <p className="book-path">{sectionLabel ?? book.section_name}{book.series_name ? ` / ${book.series_name}` : ""}</p>
        )}
      </div>
    </>
  );

  if (book.parse_status !== "ok") {
    return (
      <li className="book-card">
        {onToggle && <BookSelection book={book} selected={selected} onToggle={onToggle} />}
        {card}
      </li>
    );
  }
  return (
    <li className="book-card">
      {onToggle && <BookSelection book={book} selected={selected} onToggle={onToggle} />}
      <Link
        className="book-card-link"
        to={`/reader/${book.id}`}
        state={readerReturn ? { returnTo: readerReturn } : undefined}
        aria-label={t("Read {{title}}", { title: book.title })}
      >
        {card}
      </Link>
      {offline.state === "partial" && (
        <div className="offline-cache-row">
          <span className="offline-cache-indicator" role="status">
            {t("Partial cache")}{offline.chapterCount ? ` · ${offline.chapterCount} ${t("chapters")}` : ""}{offline.pageCount ? ` · ${offline.pageCount} ${t("pages")}` : ""}
          </span>
          <button
            className="offline-clear-button"
            type="button"
            onClick={(event) => { event.stopPropagation(); void offline.clearCache(); }}
            aria-label={t("Clear cached content for {{title}}", { title: book.title })}
          >
            {t("Clear cache")}
          </button>
        </div>
      )}
      {book.missing && onRemoveMissing && (
        <button className="offline-clear-button" type="button" onClick={() => {
            void dialog.confirm(t("Remove the missing record for {{title}}?", { title: book.title }), t("Remove record")).then((confirmed) => {
              if (confirmed) onRemoveMissing();
            });
          }}>
          {t("Remove record")}
        </button>
      )}
      {offline.state === "error" && <span className="offline-error" role="status">{t("Cache status unavailable")}</span>}
    </li>
  );
}

function BookSelection({ book, selected, onToggle }: { book: BookSummary; selected: boolean; onToggle: () => void }) {
  const { t } = useUi();
  return (
    <label className="book-select" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t("Select {{title}}", { title: book.title })} />
    </label>
  );
}

function SeriesOrderButtons({ series, onSaved }: { series: { id: number; books: BookSummary[] }; onSaved: () => Promise<unknown> }) {
  const { t } = useUi();
  const dialog = useDialog();
  const [order, setOrder] = useState(() => series.books.map((book) => book.id));
  const [saving, setSaving] = useState(false);
  useEffect(() => setOrder(series.books.map((book) => book.id)), [series.books]);
  const move = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= order.length) return;
    setOrder((current) => {
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.reorderSeriesBooks(series.id, order);
      await onSaved();
    } catch (error) {
      await dialog.alert(translateError(error, t), t("Could not save order"));
    } finally {
      setSaving(false);
    }
  };
  const changed = order.some((id, index) => id !== series.books[index]?.id);
  if (!series.books.length) return null;
  return (
    <section className="series-order" aria-label={t("Series order")}>
      <div className="series-order-head">
        <h2>{t("Book order")}</h2>
        {changed && <button className="primary-button compact-button" type="button" onClick={() => void save()} disabled={saving}>{saving ? t("Saving…") : t("Save order")}</button>}
      </div>
      <ol>
        {order.map((id, index) => {
          const book = series.books.find((entry) => entry.id === id);
          if (!book) return null;
          return <li key={id}><span>{book.title}</span><span><button className="quiet-button" type="button" onClick={() => move(index, -1)} disabled={index === 0}>{t("Up")}</button><button className="quiet-button" type="button" onClick={() => move(index, 1)} disabled={index === order.length - 1}>{t("Down")}</button></span></li>;
        })}
      </ol>
    </section>
  );
}
