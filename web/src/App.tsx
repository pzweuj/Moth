import { useMemo, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, type BookSummary, type SectionSummary, type SessionState } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { ReaderPage } from "./reader/ReaderPage";
import { useOfflineBook } from "./offline/useOfflineBook";

const queryOptions = {
  retry: 1,
  refetchOnWindowFocus: false,
};

function App() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: queryOptions } }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary
        fallback={(error) => (
          <ErrorScreen
            title="Moth hit a snag"
            message={error.message || "Something went wrong. Reloading the app usually fixes it."}
            onRetry={() => window.location.reload()}
          />
        )}
      >
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

function AppRoutes() {
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.getSetupStatus,
    networkMode: "always",
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.getSession,
    enabled: setup.data?.initialized === true,
    networkMode: "always",
  });

  useEffect(() => {
    const flushServerWork = () => {
      void (async () => {
        // A deferred server logout must be attempted before progress writes;
        // this preserves the user's explicit sign-out boundary after a
        // reconnect.
        await api.flushPendingLogout();
        await api.flushPendingProgress();
      })();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") flushServerWork();
    };
    window.addEventListener("online", flushServerWork);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", flushServerWork);
    return () => {
      window.removeEventListener("online", flushServerWork);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", flushServerWork);
    };
  }, []);

  useEffect(() => {
    if (session.data?.authenticated && !session.data.offline) void api.flushPendingProgress();
  }, [session.data?.authenticated, session.data?.offline]);

  if (setup.isPending || (setup.data?.initialized && session.isPending)) {
    return <LoadingScreen label="Opening your library" />;
  }

  if (setup.isError) {
    return (
      <ErrorScreen
        title="Moth is taking a moment"
        message="The server could not be reached. Check the connection and try again."
        onRetry={() => void setup.refetch()}
      />
    );
  }

  return (
    <>
      <UpdateNotice />
      <Routes>
      <Route
        path="/setup"
        element={<SetupPage initialized={setup.data.initialized} />}
      />
      <Route
        path="/login"
        element={
          <LoginPage
            initialized={setup.data.initialized}
            session={session.data}
          />
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <LibraryPage session={session.data} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/all"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <LibraryPage session={session.data} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/section/:sectionId"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <LibraryPage session={session.data} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/series/:seriesId"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <LibraryPage session={session.data} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reader/:id"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <ReaderPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

function UpdateNotice() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const next = (event as CustomEvent<ServiceWorkerRegistration>).detail;
      if (next?.waiting) setRegistration(next);
    };
    window.addEventListener("moth-sw-update", onUpdate);
    return () => window.removeEventListener("moth-sw-update", onUpdate);
  }, []);

  if (!registration?.waiting) return null;

  const apply = () => {
    const waiting = registration.waiting;
    if (!waiting) return;
    const reload = () => {
      navigator.serviceWorker.removeEventListener("controllerchange", reload);
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", reload);
    waiting.postMessage({ type: "SKIP_WAITING" });
  };

  return (
    <div className="update-notice" role="status">
      <span>A new Moth version is ready.</span>
      <button type="button" onClick={apply}>Refresh</button>
    </div>
  );
}

function SetupPage({ initialized }: { initialized: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const setup = useMutation({
    mutationFn: async () => {
      await api.setup(username.trim(), password);
      try {
        await api.login(username.trim(), password);
        return true;
      } catch {
        return false;
      }
    },
    onSuccess: async (signedIn) => {
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      if (signedIn) {
        navigate("/", { replace: true });
      } else {
        navigate("/login", { replace: true, state: { username: username.trim() } });
      }
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  if (initialized) {
    return <Navigate to="/login" replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      setError("Use at least 10 characters for your password.");
      return;
    }
    setup.mutate();
  };

  return (
    <AuthLayout kicker="First light" title="Make this place yours." description="Set up your account. Moth keeps the rest of the experience quiet and close to your books.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Username" value={username} onChange={setUsername} autoComplete="username" required />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={10} required />
        <Field label="Repeat password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={10} required />
        <FormError message={error} />
        <button className="primary-button" type="submit" disabled={setup.isPending}>
          {setup.isPending ? "Preparing Moth…" : "Set up your account"}
        </button>
      </form>
    </AuthLayout>
  );
}

function LoginPage({ initialized, session }: { initialized: boolean; session?: SessionState }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const state = location.state as { username?: string } | null;
  const [username, setUsername] = useState(state?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      navigate("/", { replace: true, state: null });
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  });

  if (!initialized) {
    return <Navigate to="/setup" replace />;
  }
  if (session?.authenticated && !session.offline) {
    return <Navigate to="/" replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    login.mutate();
  };

  return (
    <AuthLayout kicker="Welcome back" title="Pick up the thread." description="Your library is waiting on the other side of a simple sign-in.">
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="Username" value={username} onChange={setUsername} autoComplete="username" required />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        <FormError message={error} />
        <button className="primary-button" type="submit" disabled={login.isPending}>
          {login.isPending ? "Opening…" : "Sign in"}
        </button>
      </form>
    </AuthLayout>
  );
}

function ProtectedRoute({
  initialized,
  session,
  children,
}: {
  initialized: boolean;
  session?: SessionState;
  children: ReactNode;
}) {
  if (!initialized) {
    return <Navigate to="/setup" replace />;
  }
  if (!session?.authenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function LibraryPage({ session }: { session?: SessionState }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { sectionId: sectionParam, seriesId: seriesParam } = useParams();
  const sectionId = sectionParam ? Number(sectionParam) : undefined;
  const seriesId = seriesParam ? Number(seriesParam) : undefined;
  const isAllView = location.pathname === "/all";
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState<"all" | BookSummary["format"]>("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [moveTarget, setMoveTarget] = useState("");
  const [seriesTarget, setSeriesTarget] = useState("");
  const [searchAll, setSearchAll] = useState(false);

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
      && !window.confirm("Some reading progress has not synced. Sign out and clear this device anyway?")) {
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
    setSearchAll(false);
  }, [isAllView, sectionId, seriesId]);

  const allSections = sections.data ?? [];
  const currentSection = sectionId ? allSections.find((section) => section.id === sectionId) : undefined;
  const currentSeries = seriesId
    ? allSections.flatMap((section) => section.series).find((series) => series.id === seriesId)
    : undefined;
  const query = search.trim().toLowerCase();
  const scopeBooks = useMemo(() => {
    if (searchAll || isAllView || (!sectionId && !seriesId)) return books.data ?? [];
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
    const name = window.prompt("Section name");
    if (!name?.trim()) return;
    try {
      await api.createSection(name);
      await refreshOrganization();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not create section");
    }
  };
  const renameSection = async () => {
    if (!currentSection || currentSection.is_system || session?.offline) return;
    const name = window.prompt("Section name", currentSection.name);
    if (!name?.trim() || name.trim() === currentSection.name) return;
    try {
      await api.updateSection(currentSection.id, { name });
      await refreshOrganization();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not rename section");
    }
  };
  const removeSection = async () => {
    if (!currentSection || currentSection.is_system || session?.offline) return;
    if (!window.confirm(`Move ${sectionCardBooks(currentSection)} books to Unclassified and delete ${currentSection.name}?`)) return;
    try {
      await api.deleteSection(currentSection.id);
      await refreshOrganization();
      navigate("/");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not delete section");
    }
  };
  const createSeries = async () => {
    if (!currentSection || session?.offline) return;
    const name = window.prompt("Series name");
    if (!name?.trim()) return;
    try {
      await api.createSeries(name, currentSection.id);
      await refreshOrganization();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not create series");
    }
  };
  const renameSeries = async () => {
    if (!currentSeries || session?.offline) return;
    const name = window.prompt("Series name", currentSeries.name);
    if (!name?.trim() || name.trim() === currentSeries.name) return;
    try {
      await api.updateSeries(currentSeries.id, { name });
      await refreshOrganization();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not rename series");
    }
  };
  const removeSeries = async () => {
    if (!currentSeries || session?.offline) return;
    if (!window.confirm(`Remove the ${currentSeries.name} series (${currentSeries.book_count} books)? Books will stay in its section.`)) return;
    try {
      await api.deleteSeries(currentSeries.id);
      await refreshOrganization();
      navigate(`/section/${currentSeries.section_id}`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not delete series");
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
      window.alert(error instanceof Error ? error.message : "Could not move series");
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
    onError: (error: Error) => window.alert(error.message || "Could not move books"),
  });
  const removeMissing = useMutation({
    mutationFn: (id: number) => api.deleteMissingBook(id),
    onSuccess: refreshOrganization,
    onError: (error: Error) => window.alert(error.message || "Could not remove record"),
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
      window.alert(error instanceof Error ? error.message : "Could not reorder sections");
    }
  };

  const scanning = scanStatus.data?.scanning ?? false;
  const filtered = useMemo(
    () =>
      scopeBooks.filter((book) => {
        const matchesFormat = format === "all" || book.format === format;
        const matchesSearch =
          !query ||
          book.title.toLowerCase().includes(query) ||
          (book.author?.toLowerCase().includes(query) ?? false);
        return matchesFormat && matchesSearch;
      }),
    [format, query, scopeBooks],
  );

  const hasOrganizedBooks = allSections.some((section) => section.book_count > 0);
  const toggleSelected = (id: number) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };
  const sectionCardBooks = (section: SectionSummary) => section.series.reduce((total, series) => total + series.book_count, 0) + section.books.length;

  return (
    <main className="home-shell">
      <div className="grain" aria-hidden="true" />
      <header className="home-nav">
        <span className="wordmark">Moth <span>/</span> personal library</span>
        <div className="home-actions">
          {session?.offline && (
            <button className="quiet-button" type="button" onClick={() => navigate("/login")}>
              Sign in to sync
            </button>
          )}
          <button
            className="quiet-button"
            type="button"
            onClick={() => scan.mutate()}
            disabled={scan.isPending || scanning}
          >
            {scanning ? "Scanning…" : scan.isPending ? "Starting…" : "Rescan library"}
          </button>
          <button className="quiet-button" type="button" onClick={() => void createSection()} disabled={session?.offline}>
            New section
          </button>
          <button className="quiet-button" type="button" onClick={() => void requestLogout()} disabled={logout.isPending}>
            {logout.isPending ? "Leaving…" : "Sign out"}
          </button>
        </div>
      </header>

      <section className="library-head">
        <p className="eyebrow">Good to see you, {session?.username}</p>
        <h1>{currentSeries?.name ?? currentSection?.name ?? (isAllView ? "All books" : "Your library")}</h1>
        <p className="lede">{currentSeries ? `${currentSeries.book_count} books in this series.` : currentSection ? `${sectionCardBooks(currentSection)} books in this section.` : "Books rest quietly here, ready when you are."}</p>
      </section>

      <nav className="library-breadcrumbs" aria-label="Library location">
        <Link to="/all">All books</Link>
        {currentSection && <><span aria-hidden="true">/</span><Link to={`/section/${currentSection.id}`}>{currentSection.name}</Link></>}
        {currentSeries && <><span aria-hidden="true">/</span><span>{currentSeries.name}</span></>}
      </nav>

      {!session?.offline && currentSection && !currentSeries && (
        <div className="organization-actions">
          <button className="quiet-button" type="button" onClick={() => void createSeries()}>New series</button>
          {!currentSection.is_system && <>
            <button className="quiet-button" type="button" onClick={() => void renameSection()}>Rename section</button>
            <button className="quiet-button" type="button" onClick={() => void removeSection()}>Delete section</button>
          </>}
        </div>
      )}
      {!session?.offline && currentSeries && (
        <div className="organization-actions">
          <button className="quiet-button" type="button" onClick={() => void renameSeries()}>Rename series</button>
          <select className="organization-select" aria-label="Move series to section" value={seriesTarget} onChange={(event) => setSeriesTarget(event.target.value)}>
            <option value="">Move series to…</option>
            {allSections.filter((section) => section.id !== currentSeries.section_id).map((section) => (
              <option key={section.id} value={section.id}>{section.name}</option>
            ))}
          </select>
          <button className="quiet-button" type="button" onClick={() => void moveSeries()} disabled={!seriesTarget}>Move</button>
          <button className="quiet-button" type="button" onClick={() => void removeSeries()}>Remove series</button>
        </div>
      )}

      <div className="library-toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Search title or author…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search library"
        />
        <div className="format-filter" role="group" aria-label="Filter by format">
          {(["all", "epub", "txt", "cbz", "mobi"] as const).map((entry) => (
            <button
              key={entry}
              className={`format-chip ${format === entry ? "is-active" : ""}`}
              type="button"
              onClick={() => setFormat(entry)}
            >
              {entry === "all" ? "All" : entry.toUpperCase()}
            </button>
          ))}
        </div>
        {(currentSection || currentSeries) && (
          <button className={`format-chip ${searchAll ? "is-active" : ""}`} type="button" onClick={() => setSearchAll((value) => !value)}>
            {searchAll ? "This location" : "Search all books"}
          </button>
        )}
        <OfflineStorageStatus />
      </div>

      {selectedIds.length > 0 && !session?.offline && (
        <div className="organization-toolbar" role="region" aria-label="Organize selected books">
          <span>{selectedIds.length} selected</span>
          <select aria-label="Move selected books" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
            <option value="">Move to…</option>
            {allSections.map((section) => (
              <option key={`section-${section.id}`} value={`section:${section.id}`}>{section.name}</option>
            ))}
            {allSections.flatMap((section) => section.series.map((series) => (
              <option key={`series-${series.id}`} value={`series:${series.id}`}>{section.name} / {series.name}</option>
            )))}
          </select>
          <button className="primary-button compact-button" type="button" onClick={() => organize.mutate()} disabled={organize.isPending || !moveTarget}>
            {organize.isPending ? "Moving…" : "Move"}
          </button>
          <button className="quiet-button" type="button" onClick={() => setSelectedIds([])}>Clear selection</button>
        </div>
      )}

      {scanning && (
        <p className="scan-note" role="status">
          Indexing library… {scanStatus.data?.processed ?? 0} of {scanStatus.data?.total ?? 0}
        </p>
      )}

      {books.isPending || sections.isPending ? (
        <p className="scan-note">Opening your library…</p>
      ) : !sectionId && !seriesId && !isAllView && hasOrganizedBooks && !query && format === "all" ? (
        <>
          <ul className="section-grid">
            {allSections.map((section) => (
              <li key={section.id} className="section-card">
                <Link to={`/section/${section.id}`}>
                  <span className="eyebrow">{section.is_system ? "System section" : "Section"}</span>
                  <h2>{section.name}</h2>
                  <p>{section.series.length} series · {sectionCardBooks(section)} books</p>
                </Link>
                {!section.is_system && !session?.offline && (
                  <div className="section-order-actions">
                    <button className="quiet-button" type="button" onClick={() => void reorderSection(section.id, -1)}>Up</button>
                    <button className="quiet-button" type="button" onClick={() => void reorderSection(section.id, 1)}>Down</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="shelf-hint">Open a section to browse its series and independent books.</p>
        </>
      ) : filtered.length === 0 && !(currentSection && !currentSeries && currentSection.series.length > 0) ? (
        <section className="empty-library">
          <h2>{books.data && books.data.length === 0 ? "Nothing here yet." : "Nothing matches."}</h2>
          <p>
            {books.data && books.data.length === 0
              ? "Add EPUB, TXT, CBZ, or MOBI books to the library directory, then scan."
              : "Try a different search or format filter."}
          </p>
          {books.data && books.data.length === 0 && (
            <button
              className="primary-button compact-button"
              type="button"
              onClick={() => scan.mutate()}
              disabled={scan.isPending || scanning}
            >
              Scan for books
            </button>
          )}
        </section>
      ) : (
        <>
          {currentSection && !currentSeries && !searchAll && !query && currentSection.series.length > 0 && (
            <ul className="series-grid">
              {currentSection.series.map((series) => (
                <li key={series.id} className="series-card">
                  <Link to={`/series/${series.id}`}>
                    <div className="series-cover">
                      {series.cover_url && !session?.offline ? <img src={series.cover_url} alt="" loading="lazy" /> : <span aria-hidden="true">BOOKS</span>}
                    </div>
                    <span className="eyebrow">Series</span>
                    <h2>{series.name}</h2>
                    <p>{series.book_count} books</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <ul className="book-grid">
            {filtered.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                selected={selectedIds.includes(book.id)}
                onToggle={() => toggleSelected(book.id)}
                onRemoveMissing={() => removeMissing.mutate(book.id)}
                showPath={Boolean(searchAll || query || (!sectionId && !seriesId))}
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
        Offline storage is full · <button className="inline-action" type="button" disabled={clearing} onClick={() => {
          setClearing(true);
          void api.clearOfflineContent().finally(() => setClearing(false));
        }}>{clearing ? "clearing…" : "clear cached content"}</button>
      </span>
    );
  }
  if (!estimate?.quota) {
    return <button className="storage-note storage-action" type="button" disabled={clearing} onClick={() => {
      setClearing(true);
      void api.clearOfflineContent().finally(() => setClearing(false));
    }}>{clearing ? "Clearing cache…" : "Clear cached content"}</button>;
  }
  return (
    <span className="storage-note" title="Approximate browser storage usage">
      Offline storage {formatBytes(estimate.usage ?? 0)} / {formatBytes(estimate.quota)}
      <button className="inline-action" type="button" disabled={clearing} onClick={() => {
        setClearing(true);
        void api.clearOfflineContent().finally(() => setClearing(false));
      }}>{clearing ? "clearing…" : "clear"}</button>
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
  showPath = false,
}: {
  book: BookSummary;
  selected?: boolean;
  onToggle?: () => void;
  onRemoveMissing?: () => void;
  showPath?: boolean;
}) {
  const offline = useOfflineBook(book);
  const isOnline = typeof navigator === "undefined" || navigator.onLine;
  const coverUrl = offline.state === "partial"
    ? offline.coverUrl ?? (isOnline ? book.cover_url : undefined)
    : book.cover_url;
  const card = (
    <>
      {onToggle && (
        <label className="book-select" onClick={(event) => event.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${book.title}`} />
        </label>
      )}
      <div className="book-cover">
        {book.has_cover && coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" />
        ) : (
          <div className="book-cover-placeholder" aria-hidden="true">
            <span className="cover-format">{book.format.toUpperCase()}</span>
          </div>
        )}
        {book.parse_status === "error" && (
          <span className="cover-error">Unreadable</span>
        )}
        {book.missing && <span className="cover-error">Missing file</span>}
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
        {showPath && (book.series_name || book.section_name) && (
          <p className="book-path">{book.section_name}{book.series_name ? ` / ${book.series_name}` : ""}</p>
        )}
      </div>
    </>
  );

  if (book.parse_status !== "ok") {
    return (
      <li className="book-card">
        {card}
      </li>
    );
  }
  return (
    <li className="book-card">
      <Link className="book-card-link" to={`/reader/${book.id}`} aria-label={`Read ${book.title}`}>
        {card}
      </Link>
      {offline.state === "partial" && (
        <div className="offline-cache-row">
          <span className="offline-cache-indicator" role="status">
            Partial cache{offline.chapterCount ? ` · ${offline.chapterCount} chapters` : ""}{offline.pageCount ? ` · ${offline.pageCount} pages` : ""}
          </span>
          <button
            className="offline-clear-button"
            type="button"
            onClick={(event) => { event.stopPropagation(); void offline.clearCache(); }}
            aria-label={`Clear cached content for ${book.title}`}
          >
            Clear cache
          </button>
        </div>
      )}
      {book.missing && onRemoveMissing && (
        <button className="offline-clear-button" type="button" onClick={() => {
          if (window.confirm(`Remove the missing record for ${book.title}?`)) onRemoveMissing();
        }}>
          Remove record
        </button>
      )}
      {offline.state === "error" && <span className="offline-error" role="status">Cache status unavailable</span>}
    </li>
  );
}

function SeriesOrderButtons({ series, onSaved }: { series: { id: number; books: BookSummary[] }; onSaved: () => Promise<unknown> }) {
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
      window.alert(error instanceof Error ? error.message : "Could not save order");
    } finally {
      setSaving(false);
    }
  };
  const changed = order.some((id, index) => id !== series.books[index]?.id);
  if (!series.books.length) return null;
  return (
    <section className="series-order" aria-label="Series order">
      <div className="series-order-head">
        <h2>Book order</h2>
        {changed && <button className="primary-button compact-button" type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save order"}</button>}
      </div>
      <ol>
        {order.map((id, index) => {
          const book = series.books.find((entry) => entry.id === id);
          if (!book) return null;
          return <li key={id}><span>{book.title}</span><span><button className="quiet-button" type="button" onClick={() => move(index, -1)} disabled={index === 0}>Up</button><button className="quiet-button" type="button" onClick={() => move(index, 1)} disabled={index === order.length - 1}>Down</button></span></li>;
        })}
      </ol>
    </section>
  );
}

function AuthLayout({ kicker, title, description, children }: { kicker: string; title: string; description: string; children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="grain" aria-hidden="true" />
      <section className="auth-intro">
        <p className="eyebrow">Moth / personal library</p>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
        <div className="auth-rule" />
        <p className="auth-footnote">Private by default<br />Ready when the network is not.</p>
      </section>
      <section className="auth-card" aria-label={kicker}>
        <p className="eyebrow">{kicker}</p>
        {children}
      </section>
      <aside className="landing-mark auth-mark" aria-hidden="true">
        <span className="mark-wing mark-wing-left" />
        <span className="mark-wing mark-wing-right" />
        <span className="mark-body" />
      </aside>
    </main>
  );
}

function Field({ label, type = "text", value, onChange, ...props }: { label: string; type?: string; value: string; onChange: (value: string) => void; autoComplete?: string; minLength?: number; required?: boolean }) {
  const id = label.toLowerCase().replaceAll(" ", "-");
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} {...props} />
    </label>
  );
}

function FormError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="form-error" role="alert">{message}</p>;
}

function LoadingScreen({ label }: { label: string }) {
  return <main className="state-screen"><span className="spinner" aria-hidden="true" /><p>{label}</p></main>;
}

function ErrorScreen({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <main className="state-screen">
      <p className="eyebrow">Moth / connection</p>
      <h1>{title}</h1>
      <p>{message}</p>
      <button className="primary-button compact-button" type="button" onClick={onRetry}>Try again</button>
    </main>
  );
}

export default App;

