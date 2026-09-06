import { useMemo, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, type BookSummary, type SessionState } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { ReaderPage } from "./reader/ReaderPage";

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
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.getSession,
    enabled: setup.data?.initialized === true,
  });

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
        path="/reader/:id"
        element={
          <ProtectedRoute initialized={setup.data.initialized} session={session.data}>
            <ReaderPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
  if (session?.authenticated) {
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
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState<"all" | BookSummary["format"]>("all");

  const books = useQuery({ queryKey: ["books"], queryFn: api.getBooks });
  const scan = useMutation({
    mutationFn: api.scanLibrary,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scan-status"] });
    },
  });
  const scanStatus = useQuery({
    queryKey: ["scan-status"],
    queryFn: api.getScanStatus,
    refetchInterval: (query) => (query.state.data?.scanning ? 1500 : false),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.setQueryData<SessionState>(["session"], {
        authenticated: false,
      });
      navigate("/login", { replace: true });
    },
  });

  useEffect(() => {
    if (!scanStatus.data?.scanning) {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    }
  }, [scanStatus.data?.scanning, queryClient]);

  const scanning = scanStatus.data?.scanning ?? false;
  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (books.data ?? []).filter((book) => {
        const matchesFormat = format === "all" || book.format === format;
        const matchesSearch =
          !query ||
          book.title.toLowerCase().includes(query) ||
          (book.author?.toLowerCase().includes(query) ?? false);
        return matchesFormat && matchesSearch;
      }),
    [books.data, format, query],
  );

  return (
    <main className="home-shell">
      <div className="grain" aria-hidden="true" />
      <header className="home-nav">
        <span className="wordmark">Moth <span>/</span> personal library</span>
        <div className="home-actions">
          <button
            className="quiet-button"
            type="button"
            onClick={() => scan.mutate()}
            disabled={scan.isPending || scanning}
          >
            {scanning ? "Scanning…" : scan.isPending ? "Starting…" : "Rescan library"}
          </button>
          <button className="quiet-button" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? "Leaving…" : "Sign out"}
          </button>
        </div>
      </header>

      <section className="library-head">
        <p className="eyebrow">Good to see you, {session?.username}</p>
        <h1>Your library</h1>
        <p className="lede">Books rest quietly here, ready when you are.</p>
      </section>

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
      </div>

      {scanning && (
        <p className="scan-note" role="status">
          Indexing library… {scanStatus.data?.processed ?? 0} of {scanStatus.data?.total ?? 0}
        </p>
      )}

      {books.isPending ? (
        <p className="scan-note">Opening your library…</p>
      ) : filtered.length === 0 ? (
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
        <ul className="book-grid">
          {filtered.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </ul>
      )}
    </main>
  );
}

function BookCard({ book }: { book: BookSummary }) {
  const card = (
    <>
      <div className="book-cover">
        {book.has_cover && book.cover_url ? (
          <img src={book.cover_url} alt="" loading="lazy" />
        ) : (
          <div className="book-cover-placeholder" aria-hidden="true">
            <span className="cover-format">{book.format.toUpperCase()}</span>
          </div>
        )}
        {book.parse_status === "error" && (
          <span className="cover-error">Unreadable</span>
        )}
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
      </div>
    </>
  );

  if (book.parse_status !== "ok") {
    return <li className="book-card">{card}</li>;
  }
  return (
    <li className="book-card">
      <Link className="book-card-link" to={`/reader/${book.id}`} aria-label={`Read ${book.title}`}>
        {card}
      </Link>
    </li>
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

