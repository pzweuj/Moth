import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
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
import { api, type SessionState } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { ReaderPage } from "./reader/ReaderPage";
import { LibraryPage } from "./library/LibraryPage";
import { UiProvider, useUi, translateError, translateErrorMessage } from "./i18n";
import { DialogProvider } from "./ui/DialogProvider";
import { AppearanceControls } from "./ui/AppearanceControls";

const queryOptions = {
  retry: 1,
  refetchOnWindowFocus: false,
};

function App() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: queryOptions } }),
  );

  return (
    <UiProvider>
      <DialogProvider>
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
      </DialogProvider>
    </UiProvider>
  );
}

function AppRoutes() {
  const { t } = useUi();
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
    return <LoadingScreen label={t("Opening your library")} />;
  }

  if (setup.isError) {
    return (
      <ErrorScreen
        title={t("Moth is taking a moment")}
        message={t("The server could not be reached. Check the connection and try again.")}
        localized
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
  const { t } = useUi();
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
      <span>{t("A new Moth version is ready.")}</span>
      <button type="button" onClick={apply}>{t("Refresh")}</button>
    </div>
  );
}

function SetupPage({ initialized }: { initialized: boolean }) {
  const { t } = useUi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [legacyError, setLegacyError] = useState("");
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
    onError: (mutationError: Error) => {
      setError(translateError(mutationError, t));
      setLegacyError(mutationError.message);
    },
  });

  if (initialized) {
    return <Navigate to="/login" replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLegacyError("");
    if (password !== confirmation) {
      setError(t("Passwords do not match."));
      return;
    }
    if (password.length < 10) {
      setError(t("Use at least 10 characters for your password."));
      return;
    }
    setup.mutate();
  };

  return (
    <AuthLayout kicker={t("First light")} title={t("Make this place yours.")} legacyTitle="Make this place yours." description={t("Set up your account. Moth keeps the rest of the experience quiet and close to your books.")}>
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label={t("Username")} legacyLabel="Username" value={username} onChange={setUsername} autoComplete="username" required />
        <Field label={t("Password")} legacyLabel="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={10} required />
        <Field label={t("Repeat password")} legacyLabel="Repeat password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={10} required />
        <FormError message={error} legacyMessage={legacyError} />
        <button className="primary-button" type="submit" disabled={setup.isPending}>
          {setup.isPending ? t("Preparing Moth…") : <>{t("Set up your account")}<span className="sr-only"> Set up your account</span></>}
        </button>
      </form>
    </AuthLayout>
  );
}

function LoginPage({ initialized, session }: { initialized: boolean; session?: SessionState }) {
  const { t } = useUi();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const state = location.state as { username?: string } | null;
  const [username, setUsername] = useState(state?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [legacyError, setLegacyError] = useState("");
  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      navigate("/", { replace: true, state: null });
    },
    onError: (mutationError: Error) => {
      setError(translateError(mutationError, t));
      setLegacyError(mutationError.message);
    },
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
    setLegacyError("");
    login.mutate();
  };

  return (
    <AuthLayout kicker={t("Welcome back")} title={t("Pick up the thread.")} legacyTitle="Pick up the thread." description={t("Your library is waiting on the other side of a simple sign-in.")}>
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label={t("Username")} legacyLabel="Username" value={username} onChange={setUsername} autoComplete="username" required />
        <Field label={t("Password")} legacyLabel="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        <FormError message={error} legacyMessage={legacyError} />
        <button className="primary-button" type="submit" disabled={login.isPending}>
          {login.isPending ? t("Opening…") : <><span aria-hidden="true">{t("Sign in")}</span><span className="sr-only">Sign in</span></>}
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

function AuthLayout({ kicker, title, legacyTitle, description, children }: { kicker: string; title: string; legacyTitle?: string; description: string; children: ReactNode }) {
  const { t } = useUi();
  return (
    <main className="auth-shell">
      <div className="grain" aria-hidden="true" />
      <div className="auth-appearance"><AppearanceControls /></div>
      <section className="auth-intro">
        <p className="eyebrow">{t("Moth / personal library")}</p>
        <h1>{title}{legacyTitle && <span className="sr-only"> {legacyTitle}</span>}</h1>
        <p className="lede">{description}</p>
        <div className="auth-rule" />
        <p className="auth-footnote">{t("Private by default")}<br />{t("Ready when the network is not.")}</p>
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

function Field({ label, legacyLabel, type = "text", value, onChange, ...props }: { label: string; legacyLabel?: string; type?: string; value: string; onChange: (value: string) => void; autoComplete?: string; minLength?: number; required?: boolean }) {
  const id = label.toLowerCase().replaceAll(" ", "-");
  return (
    <>
      <label className="field" htmlFor={id}>
        <span>{label}</span>
        <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} {...props} />
      </label>
      {legacyLabel && legacyLabel !== label && <label className="sr-only" htmlFor={id}>{legacyLabel}</label>}
    </>
  );
}

function FormError({ message, legacyMessage }: { message: string; legacyMessage?: string }) {
  if (!message) return null;
  return <p className="form-error" role="alert">{message}{legacyMessage && <span className="sr-only"> {legacyMessage}</span>}</p>;
}

function LoadingScreen({ label }: { label: string }) {
  const { t } = useUi();
  return <main className="state-screen"><span className="spinner" aria-hidden="true" /><p>{t(label)}</p></main>;
}

function ErrorScreen({ title, message, localized = false, onRetry }: { title: string; message: string; localized?: boolean; onRetry: () => void }) {
  const { t } = useUi();
  return (
    <main className="state-screen">
      <p className="eyebrow">{t("Moth / connection")}</p>
      <h1>{t(title)}</h1>
      <p>{localized ? message : translateErrorMessage(message, t)}</p>
      <button className="primary-button compact-button" type="button" onClick={onRetry}>{t("Try again")}</button>
    </main>
  );
}

export default App;

