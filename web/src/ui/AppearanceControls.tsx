import { useUi, type AppTheme, type Locale } from "../i18n";

export function AppearanceControls({ compact = false, showLocale = true, showTheme = true }: { compact?: boolean; showLocale?: boolean; showTheme?: boolean }) {
  const { locale, theme, setLocale, setTheme, t } = useUi();
  const selectLocale = (next: Locale) => setLocale(next);
  const selectTheme = (next: AppTheme) => setTheme(next);
  return (
    <div className={`appearance-controls ${compact ? "is-compact" : ""}`} role="group" aria-label={t("Appearance")}>
      {showLocale && <div className="appearance-locale" role="group" aria-label={t("Language")}>
        <button type="button" className={locale === "zh-CN" ? "is-active" : ""} aria-pressed={locale === "zh-CN"} onClick={() => selectLocale("zh-CN")}>
          中文
        </button>
        <button type="button" className={locale === "en" ? "is-active" : ""} aria-pressed={locale === "en"} onClick={() => selectLocale("en")}>
          EN
        </button>
      </div>}
      {showTheme && <div className="appearance-theme" role="group" aria-label={t("Theme")}>
        <button type="button" className={theme === "light" ? "is-active" : ""} aria-pressed={theme === "light"} aria-label={t("Light mode")} title={t("Light mode")} onClick={() => selectTheme("light")}>
          ◐
        </button>
        <button type="button" className={theme === "dark" ? "is-active" : ""} aria-pressed={theme === "dark"} aria-label={t("Dark mode")} title={t("Dark mode")} onClick={() => selectTheme("dark")}>
          ◑
        </button>
      </div>}
    </div>
  );
}
