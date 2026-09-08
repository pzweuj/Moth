import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, type SessionState } from "./api";
import { LibraryPage } from "./library/LibraryPage";
import { ReaderPage } from "./reader/ReaderPage";

type Theme = "light" | "dark";
type ThemeProps = { theme: Theme; onToggleTheme: () => void };

function ThemeToggle({ theme, onToggleTheme }: ThemeProps) {
  return <button className="quiet-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "dark" ? "日间" : "夜间"}</button>;
}

export default function App() {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("moth:theme") === "dark" ? "dark" : "light");
  const onToggleTheme = () => setTheme((value) => value === "dark" ? "light" : "dark");
  const refresh = async () => {
    try { const status = await api.setupStatus(); setSetup(status.initialized); setSession(status.initialized ? await api.session() : { authenticated: false }); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法连接服务器"); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("moth:theme", theme);
  }, [theme]);
  useEffect(() => {
    const onUpdate = (event: Event) => {
      const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail;
      if (registration) setUpdate(registration);
    };
    const onControllerChange = () => window.location.reload();
    window.addEventListener("moth-sw-update", onUpdate);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    return () => {
      window.removeEventListener("moth-sw-update", onUpdate);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);
  if (error) return <main className="state-screen"><h1>连接失败</h1><p>{error}</p><button className="primary-button" type="button" onClick={() => { setError(null); void refresh(); }}>重试</button></main>;
  if (setup === null || session === null) return <main className="state-screen"><p>正在打开 Moth…</p></main>;
  return <BrowserRouter>{update && <UpdateNotice registration={update} onDismiss={() => setUpdate(null)} />}<Routes>
    <Route path="/setup" element={setup ? <Navigate to="/login" replace /> : <SetupPage onDone={refresh} {...{ theme, onToggleTheme }} />} />
    <Route path="/login" element={!setup ? <Navigate to="/setup" replace /> : session.authenticated ? <Navigate to="/" replace /> : <LoginPage onDone={refresh} {...{ theme, onToggleTheme }} />} />
    <Route path="/reader/:id" element={<Protected session={session}><ReaderPage theme={theme} /></Protected>} />
    <Route path="*" element={<Protected session={session}><LibraryPage onLogout={async () => { await api.logout(); await refresh(); }} {...{ theme, onToggleTheme }} /></Protected>} />
  </Routes></BrowserRouter>;
}

function UpdateNotice({ registration, onDismiss }: { registration: ServiceWorkerRegistration; onDismiss: () => void }) {
  const apply = () => {
    registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    onDismiss();
  };
  return <div className="sw-update" role="status"><span>有新的 Moth 版本可用。</span><button type="button" onClick={apply}>立即更新</button><button className="quiet-button" type="button" onClick={onDismiss}>稍后</button></div>;
}

function Protected({ session, children }: { session: SessionState; children: ReactNode }) { return session.authenticated ? <>{children}</> : <Navigate to="/login" replace />; }

function AuthLayout({ title, children, theme, onToggleTheme }: { title: string; children: ReactNode } & ThemeProps) { return <main className="auth-shell"><div className="auth-appearance"><ThemeToggle theme={theme} onToggleTheme={onToggleTheme} /></div><section className="auth-intro"><p className="eyebrow">MOTH / 个人书库</p><h1>{title}</h1><p className="lede">文件留在你的书库里，阅读体验保持轻盈。</p></section><section className="auth-card">{children}</section></main>; }

function SetupPage({ onDone, theme, onToggleTheme }: { onDone: () => Promise<void> } & ThemeProps) {
  const navigate = useNavigate(); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [repeat, setRepeat] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(""); if (password.length < 10 || password !== repeat) { setError(password.length < 10 ? "密码至少需要 10 个字符" : "两次密码不一致"); return; } setSaving(true); try { await api.setup(username.trim(), password); await api.login(username.trim(), password); await onDone(); navigate("/", { replace: true }); } catch (reason) { setError(reason instanceof Error ? reason.message : "设置失败"); } finally { setSaving(false); } };
  return <AuthLayout title="从你的书库开始" theme={theme} onToggleTheme={onToggleTheme}><form className="auth-form" onSubmit={submit}><label className="field"><span>用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="field"><span>重复密码</span><input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={saving}>{saving ? "正在准备…" : "创建账户"}</button></form></AuthLayout>;
}

function LoginPage({ onDone, theme, onToggleTheme }: { onDone: () => Promise<void> } & ThemeProps) {
  const navigate = useNavigate(); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(""); try { await api.login(username.trim(), password); await onDone(); navigate("/", { replace: true }); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } finally { setSaving(false); } };
  return <AuthLayout title="继续阅读" theme={theme} onToggleTheme={onToggleTheme}><form className="auth-form" onSubmit={submit}><label className="field"><span>用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={saving}>{saving ? "正在登录…" : "登录"}</button></form></AuthLayout>;
}
