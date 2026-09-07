import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh-CN" | "en";
export type AppTheme = "light" | "dark";

type Message = string | ((values: Record<string, string | number>) => string);

const STORAGE_KEY = "moth:ui-preferences";
const LEGACY_READER_STORAGE_KEY = "moth:reader-settings";

const messages: Record<string, { "zh-CN": Message; en: Message }> = {
  "Moth / personal library": { "zh-CN": "Moth / 个人书库", en: "Moth / personal library" },
  "Moth / connection": { "zh-CN": "Moth / 连接状态", en: "Moth / connection" },
  "Moth / reader": { "zh-CN": "Moth / 阅读器", en: "Moth / reader" },
  "First light": { "zh-CN": "初次设置", en: "First light" },
  "Welcome back": { "zh-CN": "欢迎回来", en: "Welcome back" },
  "Make this place yours.": { "zh-CN": "打造你的阅读空间。", en: "Make this place yours." },
  "Pick up the thread.": { "zh-CN": "继续上次阅读。", en: "Pick up the thread." },
  "Set up your account. Moth keeps the rest of the experience quiet and close to your books.": {
    "zh-CN": "创建账户，Moth 会把阅读体验安静地留在你的书旁。",
    en: "Set up your account. Moth keeps the rest of the experience quiet and close to your books.",
  },
  "Your library is waiting on the other side of a simple sign-in.": {
    "zh-CN": "登录后，你的书库就会在这里等你。",
    en: "Your library is waiting on the other side of a simple sign-in.",
  },
  "Private by default": { "zh-CN": "默认保持私密", en: "Private by default" },
  "Ready when the network is not.": { "zh-CN": "没有网络也能随时阅读。", en: "Ready when the network is not." },
  "Username": { "zh-CN": "用户名", en: "Username" },
  "Password": { "zh-CN": "密码", en: "Password" },
  "Repeat password": { "zh-CN": "确认密码", en: "Repeat password" },
  "Preparing Moth…": { "zh-CN": "正在准备 Moth…", en: "Preparing Moth…" },
  "Set up your account": { "zh-CN": "创建账户", en: "Set up your account" },
  "Passwords do not match.": { "zh-CN": "两次输入的密码不一致。", en: "Passwords do not match." },
  "Use at least 10 characters for your password.": { "zh-CN": "密码至少需要 10 个字符。", en: "Use at least 10 characters for your password." },
  "Opening…": { "zh-CN": "正在打开…", en: "Opening…" },
  "Sign in": { "zh-CN": "登录", en: "Sign in" },
  "Moth is taking a moment": { "zh-CN": "Moth 正在连接", en: "Moth is taking a moment" },
  "The server could not be reached. Check the connection and try again.": {
    "zh-CN": "无法连接服务器，请检查连接后重试。",
    en: "The server could not be reached. Check the connection and try again.",
  },
  "Moth hit a snag": { "zh-CN": "Moth 遇到了问题", en: "Moth hit a snag" },
  "Invalid username or password": { "zh-CN": "用户名或密码错误", en: "Invalid username or password" },
  "The requested resource was not found": { "zh-CN": "找不到请求的内容。", en: "The requested resource was not found" },
  "An internal server error occurred": { "zh-CN": "服务器出现内部错误。", en: "An internal server error occurred" },
  "Request timed out": { "zh-CN": "请求超时，请稍后重试", en: "Request timed out" },
  "Something went wrong. Please try again.": { "zh-CN": "出现了问题，请稍后重试。", en: "Something went wrong. Please try again." },
  "Request was cancelled": { "zh-CN": "请求已取消。", en: "Request was cancelled" },
  "The book changed while it was opening. Refresh and try again.": { "zh-CN": "书籍在打开时发生了变化，请刷新后重试。", en: "The book changed while it was opening. Refresh and try again." },
  "The book changed while it was being read. Refresh before continuing.": { "zh-CN": "书籍在阅读时发生了变化，请刷新后再继续。", en: "The book changed while it was being read. Refresh before continuing." },
  "The book changed; refresh before continuing.": { "zh-CN": "书籍已发生变化，请刷新后再继续。", en: "The book changed; refresh before continuing." },
  "This book could not be opened.": { "zh-CN": "无法打开这本书。", en: "This book could not be opened." },
  "This book could not be displayed.": { "zh-CN": "无法显示这本书。", en: "This book could not be displayed." },
  "No readable pages in this archive.": { "zh-CN": "压缩包中没有可读取的页面。", en: "No readable pages in this archive." },
  "Could not load page": { "zh-CN": "无法加载页面", en: "Could not load page" },
  "Name cannot be empty": { "zh-CN": "名称不能为空。", en: "Name cannot be empty" },
  "Name is too long": { "zh-CN": "名称过长。", en: "Name is too long" },
  "A section with that name already exists": { "zh-CN": "已有同名栏目。", en: "A section with that name already exists" },
  "A series with that name already exists in this section": { "zh-CN": "该栏目中已有同名系列。", en: "A series with that name already exists in this section" },
  "The destination section already has a series with that name": { "zh-CN": "目标栏目中已有同名系列。", en: "The destination section already has a series with that name" },
  "The system section cannot be changed": { "zh-CN": "系统栏目不能修改。", en: "The system section cannot be changed" },
  "Only a missing book record can be removed": { "zh-CN": "只能删除缺失书籍记录。", en: "Only a missing book record can be removed" },
  "Choose exactly one destination": { "zh-CN": "请选择一个目标栏目或系列。", en: "Choose exactly one destination" },
  "The order must include every book in the series": { "zh-CN": "排序必须包含系列中的全部书籍。", en: "The order must include every book in the series" },
  "The order contains a book from another series": { "zh-CN": "排序中包含其他系列的书籍。", en: "The order contains a book from another series" },
  "Choose either a section or a series filter": { "zh-CN": "栏目和系列筛选只能选择一个。", en: "Choose either a section or a series filter" },
  "Could not create section": { "zh-CN": "无法创建栏目", en: "Could not create section" },
  "Could not rename section": { "zh-CN": "无法重命名栏目", en: "Could not rename section" },
  "Could not delete section": { "zh-CN": "无法删除栏目", en: "Could not delete section" },
  "Could not create series": { "zh-CN": "无法创建系列", en: "Could not create series" },
  "Could not rename series": { "zh-CN": "无法重命名系列", en: "Could not rename series" },
  "Could not delete series": { "zh-CN": "无法删除系列", en: "Could not delete series" },
  "Could not move series": { "zh-CN": "无法移动系列", en: "Could not move series" },
  "Could not move books": { "zh-CN": "无法移动书籍", en: "Could not move books" },
  "Could not remove record": { "zh-CN": "无法删除记录", en: "Could not remove record" },
  "Could not reorder sections": { "zh-CN": "无法调整栏目顺序", en: "Could not reorder sections" },
  "Could not save order": { "zh-CN": "无法保存顺序", en: "Could not save order" },
  "Choose a destination first": { "zh-CN": "请先选择目标位置", en: "Choose a destination first" },
  "Enter a section name": { "zh-CN": "请输入栏目名称", en: "Enter a section name" },
  "Enter a series name": { "zh-CN": "请输入系列名称", en: "Enter a series name" },
  "Some reading progress has not synced. Sign out and clear this device anyway?": {
    "zh-CN": "部分阅读进度尚未同步。仍要退出并清理此设备吗？",
    en: "Some reading progress has not synced. Sign out and clear this device anyway?",
  },
  "Move {{count}} books to Unclassified and delete {{name}}?": {
    "zh-CN": "将 {{count}} 本书移至未分类并删除“{{name}}”吗？",
    en: "Move {{count}} books to Unclassified and delete {{name}}?",
  },
  "Remove the {{name}} series ({{count}} books)? Books will stay in its section.": {
    "zh-CN": "移除“{{name}}”系列（{{count}} 本书）吗？书籍会保留在原栏目中。",
    en: "Remove the {{name}} series ({{count}} books)? Books will stay in its section.",
  },
  "Remove the missing record for {{title}}?": {
    "zh-CN": "删除《{{title}}》的缺失记录吗？",
    en: "Remove the missing record for {{title}}?",
  },
  "Something went wrong. Reloading the app usually fixes it.": {
    "zh-CN": "出现了问题，重新加载页面通常可以解决。",
    en: "Something went wrong. Reloading the app usually fixes it.",
  },
  "Try again": { "zh-CN": "重试", en: "Try again" },
  "A new Moth version is ready.": { "zh-CN": "Moth 有新版本可用。", en: "A new Moth version is ready." },
  "Refresh": { "zh-CN": "刷新", en: "Refresh" },
  "Opening your library": { "zh-CN": "正在打开书库", en: "Opening your library" },
  "Good to see you, {{name}}": { "zh-CN": "欢迎回来，{{name}}", en: "Good to see you, {{name}}" },
  "personal library": { "zh-CN": "个人书库", en: "personal library" },
  "Rescan library": { "zh-CN": "重新扫描书库", en: "Rescan library" },
  "Scanning…": { "zh-CN": "扫描中…", en: "Scanning…" },
  "Starting…": { "zh-CN": "正在启动…", en: "Starting…" },
  "New section": { "zh-CN": "新建栏目", en: "New section" },
  "Leaving…": { "zh-CN": "正在退出…", en: "Leaving…" },
  "Sign out": { "zh-CN": "退出登录", en: "Sign out" },
  "Your library": { "zh-CN": "我的书库", en: "Your library" },
  "All books": { "zh-CN": "全部书籍", en: "All books" },
  "Unclassified": { "zh-CN": "未分类", en: "Unclassified" },
  "Library shortcuts": { "zh-CN": "书库快捷入口", en: "Library shortcuts" },
  "Books rest quietly here, ready when you are.": {
    "zh-CN": "书籍安静地在这里等你。",
    en: "Books rest quietly here, ready when you are.",
  },
  "{{count}} books in this section.": { "zh-CN": "{{count}} 本书籍属于此栏目。", en: "{{count}} books in this section." },
  "{{count}} books in this series.": { "zh-CN": "{{count}} 本书籍属于此系列。", en: "{{count}} books in this series." },
  "Section": { "zh-CN": "栏目", en: "Section" },
  "System section": { "zh-CN": "系统栏目", en: "System section" },
  "Series": { "zh-CN": "系列", en: "Series" },
  "series": { "zh-CN": "个系列", en: "series" },
  "books": { "zh-CN": "本书", en: "books" },
  "Open a section to browse its series and independent books.": {
    "zh-CN": "打开栏目，浏览其中的系列和独立书籍。",
    en: "Open a section to browse its series and independent books.",
  },
  "New series": { "zh-CN": "新建系列", en: "New series" },
  "Rename section": { "zh-CN": "重命名栏目", en: "Rename section" },
  "Delete section": { "zh-CN": "删除栏目", en: "Delete section" },
  "Rename series": { "zh-CN": "重命名系列", en: "Rename series" },
  "Move series to section": { "zh-CN": "将系列移动到栏目", en: "Move series to section" },
  "Move series to…": { "zh-CN": "将系列移动到…", en: "Move series to…" },
  "Move": { "zh-CN": "移动", en: "Move" },
  "Remove series": { "zh-CN": "移除系列", en: "Remove series" },
  "Search title or author…": { "zh-CN": "搜索书名或作者…", en: "Search title or author…" },
  "Search library": { "zh-CN": "搜索书库", en: "Search library" },
  "Filter by format": { "zh-CN": "按格式筛选", en: "Filter by format" },
  "All": { "zh-CN": "全部", en: "All" },
  "This location": { "zh-CN": "当前位置", en: "This location" },
  "Search all books": { "zh-CN": "搜索全部书籍", en: "Search all books" },
  "selected": { "zh-CN": "已选择", en: "selected" },
  "Organize selected books": { "zh-CN": "整理选中的书籍", en: "Organize selected books" },
  "Move selected books": { "zh-CN": "移动选中的书籍", en: "Move selected books" },
  "Move to…": { "zh-CN": "移动到…", en: "Move to…" },
  "Moving…": { "zh-CN": "移动中…", en: "Moving…" },
  "Clear selection": { "zh-CN": "清除选择", en: "Clear selection" },
  "Name": { "zh-CN": "名称", en: "Name" },
  "Save": { "zh-CN": "保存", en: "Save" },
  "Edit": { "zh-CN": "编辑", en: "Edit" },
  "Please confirm": { "zh-CN": "请确认", en: "Please confirm" },
  "Notice": { "zh-CN": "提示", en: "Notice" },
  "Cancel": { "zh-CN": "取消", en: "Cancel" },
  "Confirm": { "zh-CN": "确认", en: "Confirm" },
  "OK": { "zh-CN": "好的", en: "OK" },
  "Indexing library…": { "zh-CN": "正在索引书库…", en: "Indexing library…" },
  "Nothing here yet.": { "zh-CN": "这里还没有书。", en: "Nothing here yet." },
  "Nothing matches.": { "zh-CN": "没有匹配的书籍。", en: "Nothing matches." },
  "Add EPUB, TXT, CBZ, or MOBI books to the library directory, then scan.": {
    "zh-CN": "把 EPUB、TXT、CBZ 或 MOBI 书籍放入书库目录，然后重新扫描。",
    en: "Add EPUB, TXT, CBZ, or MOBI books to the library directory, then scan.",
  },
  "Try a different search or format filter.": { "zh-CN": "试试其他搜索词或格式筛选。", en: "Try a different search or format filter." },
  "Scan for books": { "zh-CN": "扫描书籍", en: "Scan for books" },
  "Up": { "zh-CN": "上移", en: "Up" },
  "Down": { "zh-CN": "下移", en: "Down" },
  "BOOKS": { "zh-CN": "书籍", en: "BOOKS" },
  "Offline storage is full": { "zh-CN": "离线存储空间已满", en: "Offline storage is full" },
  "clear cached content": { "zh-CN": "清理缓存内容", en: "clear cached content" },
  "clearing…": { "zh-CN": "清理中…", en: "clearing…" },
  "Clear cached content…": { "zh-CN": "清理缓存内容…", en: "Clear cached content…" },
  "Clear cached content": { "zh-CN": "清理缓存内容", en: "Clear cached content" },
  "clear": { "zh-CN": "清理", en: "clear" },
  "Approximate browser storage usage": { "zh-CN": "浏览器存储用量估算", en: "Approximate browser storage usage" },
  "Offline storage": { "zh-CN": "离线存储", en: "Offline storage" },
  "Partial cache": { "zh-CN": "部分缓存", en: "Partial cache" },
  "chapters": { "zh-CN": "个章节", en: "chapters" },
  "pages": { "zh-CN": "页", en: "pages" },
  "Cache status unavailable": { "zh-CN": "无法获取缓存状态", en: "Cache status unavailable" },
  "Clear cache": { "zh-CN": "清理缓存", en: "Clear cache" },
  "Missing file": { "zh-CN": "文件缺失", en: "Missing file" },
  "Unreadable": { "zh-CN": "无法读取", en: "Unreadable" },
  "Read {{title}}": { "zh-CN": "阅读《{{title}}》", en: "Read {{title}}" },
  "Select {{title}}": { "zh-CN": "选择《{{title}}》", en: "Select {{title}}" },
  "Clear cached content for {{title}}": { "zh-CN": "清理《{{title}}》的缓存内容", en: "Clear cached content for {{title}}" },
  "Remove record": { "zh-CN": "删除记录", en: "Remove record" },
  "Series order": { "zh-CN": "系列顺序", en: "Series order" },
  "Book order": { "zh-CN": "书籍顺序", en: "Book order" },
  "Save order": { "zh-CN": "保存顺序", en: "Save order" },
  "Saving…": { "zh-CN": "保存中…", en: "Saving…" },
  "Saved on device": { "zh-CN": "已保存到设备", en: "Saved on device" },
  "Saved": { "zh-CN": "已保存", en: "Saved" },
  "Sign in to sync": { "zh-CN": "登录以同步", en: "Sign in to sync" },
  "Save failed": { "zh-CN": "保存失败", en: "Save failed" },
  "Could not save on device": { "zh-CN": "无法保存到设备", en: "Could not save on device" },
  "Opening your book…": { "zh-CN": "正在打开书籍…", en: "Opening your book…" },
  "Restoring your place…": { "zh-CN": "正在恢复阅读位置…", en: "Restoring your place…" },
  "Book unavailable": { "zh-CN": "书籍不可用", en: "Book unavailable" },
  "Back to library": { "zh-CN": "返回书库", en: "Back to library" },
  "Reader settings": { "zh-CN": "阅读器设置", en: "Reader settings" },
  "Font size": { "zh-CN": "字号", en: "Font size" },
  "Line height": { "zh-CN": "行距", en: "Line height" },
  "Margin": { "zh-CN": "页边距", en: "Margin" },
  "Theme": { "zh-CN": "主题", en: "Theme" },
  "Appearance": { "zh-CN": "外观设置", en: "Appearance" },
  "Language": { "zh-CN": "语言", en: "Language" },
  "Light mode": { "zh-CN": "日间模式", en: "Light mode" },
  "Dark mode": { "zh-CN": "夜间模式", en: "Dark mode" },
  "Light": { "zh-CN": "日间", en: "Light" },
  "Sepia": { "zh-CN": "护眼纸色", en: "Sepia" },
  "Dark": { "zh-CN": "夜间", en: "Dark" },
  "Encoding": { "zh-CN": "编码", en: "Encoding" },
  "Fixed-layout EPUBs keep their original layout; text reflow is unavailable.": {
    "zh-CN": "固定版式 EPUB 会保留原始布局，不支持正文重排。",
    en: "Fixed-layout EPUBs keep their original layout; text reflow is unavailable.",
  },
  "Done": { "zh-CN": "完成", en: "Done" },
  "Contents": { "zh-CN": "目录", en: "Contents" },
  "Close contents": { "zh-CN": "关闭目录", en: "Close contents" },
  "Prev": { "zh-CN": "上一页", en: "Prev" },
  "Next": { "zh-CN": "下一页", en: "Next" },
  "Fit width": { "zh-CN": "适应宽度", en: "Fit width" },
  "Fit height": { "zh-CN": "适应高度", en: "Fit height" },
  "Fit screen": { "zh-CN": "适应屏幕", en: "Fit screen" },
  "Custom zoom": { "zh-CN": "自定义缩放", en: "Custom zoom" },
  "Reset": { "zh-CN": "恢复默认", en: "Reset" },
  "Previous page": { "zh-CN": "上一页", en: "Previous page" },
  "Next page": { "zh-CN": "下一页", en: "Next page" },
  "Page {{page}} of {{total}}": { "zh-CN": "第 {{page}} / {{total}} 页", en: "Page {{page}} of {{total}}" },
  "Tap the left or right side to turn the page": { "zh-CN": "点击页面左侧或右侧翻页", en: "Tap the left or right side to turn the page" },
  "Got it": { "zh-CN": "知道了", en: "Got it" },
  "Chapter": { "zh-CN": "章节", en: "Chapter" },
  "Auto": { "zh-CN": "自动", en: "Auto" },
  "Decrease font size": { "zh-CN": "减小字号", en: "Decrease font size" },
  "Increase font size": { "zh-CN": "增大字号", en: "Increase font size" },
  "Image size": { "zh-CN": "图片大小", en: "Image size" },
  "Zoom": { "zh-CN": "缩放", en: "Zoom" },
  "Decrease zoom": { "zh-CN": "缩小图片", en: "Decrease zoom" },
  "Increase zoom": { "zh-CN": "放大图片", en: "Increase zoom" },
  "Pages": { "zh-CN": "页面", en: "Pages" },
  "Loading page…": { "zh-CN": "正在加载页面…", en: "Loading page…" },
  "Opening comic…": { "zh-CN": "正在打开漫画…", en: "Opening comic…" },
  "Retry page": { "zh-CN": "重试页面", en: "Retry page" },
  "Could not load this page.": { "zh-CN": "无法加载此页面。", en: "Could not load this page." },
  "Could not open this comic.": { "zh-CN": "无法打开这本漫画。", en: "Could not open this comic." },
  "This page is not cached yet. Connect to the server to continue reading.": {
    "zh-CN": "此页面尚未缓存，请连接服务器后继续阅读。",
    en: "This page is not cached yet. Connect to the server to continue reading.",
  },
  "This book is not cached on this device. Connect to the server to open it.": {
    "zh-CN": "此设备没有缓存这本书，请连接服务器后打开。",
    en: "This book is not cached on this device. Connect to the server to open it.",
  },
  "This chapter is not cached yet. Connect to the server to continue reading.": {
    "zh-CN": "此章节尚未缓存，请连接服务器后继续阅读。",
    en: "This chapter is not cached yet. Connect to the server to continue reading.",
  },
  "This comic has no cached pages. Connect to the server to begin reading.": {
    "zh-CN": "这本漫画没有已缓存的页面，请连接服务器后开始阅读。",
    en: "This comic has no cached pages. Connect to the server to begin reading.",
  },
  "Go to page {{page}}": { "zh-CN": "前往第 {{page}} 页", en: "Go to page {{page}}" },
  "Library location": { "zh-CN": "书库位置", en: "Library location" },
};

type UiContextValue = {
  locale: Locale;
  theme: AppTheme;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: AppTheme) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
};

const UiContext = createContext<UiContextValue | null>(null);

export function readPreferences(): { locale: Locale; theme: AppTheme } {
  let locale: Locale = "zh-CN";
  let theme: AppTheme | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<{ locale: Locale; theme: AppTheme }>;
      locale = value.locale === "en" ? "en" : "zh-CN";
      if (value.theme === "dark" || value.theme === "light") theme = value.theme;
    }
  } catch {
    // A malformed preference should not prevent the app from starting. The
    // legacy reader preference is still considered below.
  }
  // Before the site-wide appearance preference existed, a dark reader theme
  // was the only durable dark-mode signal. Migrate it without overwriting an
  // explicit site preference chosen by the user.
  if (!theme) {
    try {
      const legacy = localStorage.getItem(LEGACY_READER_STORAGE_KEY);
      const value = legacy ? JSON.parse(legacy) as Partial<{ theme: ReaderThemeValue }> : null;
      theme = value?.theme === "dark" ? "dark" : "light";
    } catch {
      theme = "light";
    }
  }
  return { locale, theme };
}

type ReaderThemeValue = "light" | "sepia" | "dark";

function interpolate(value: string, values?: Record<string, string | number>): string {
  if (!values) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ""));
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const { locale, theme } = preferences;
  const setLocale = (next: Locale) => setPreferences((current) => ({ ...current, locale: next }));
  const setTheme = (next: AppTheme) => setPreferences((current) => ({ ...current, theme: next }));
  const value = useMemo<UiContextValue>(() => ({
    locale,
    theme,
    setLocale,
    setTheme,
    t: (key, values) => {
      const localized = messages[key]?.[locale];
      const value = typeof localized === "function" ? localized(values ?? {}) : localized ?? key;
      return interpolate(value, values);
    },
  }), [locale, theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ locale, theme }));
    } catch {
      // Preferences remain available for the current session.
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.documentElement.dataset.theme = theme;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (meta) meta.content = theme === "dark" ? "#151a19" : "#f6f5ef";
      document.title = locale === "zh-CN" ? "Moth · 个人书库" : "Moth · Personal library";
    }
  }, [locale, theme]);

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const value = useContext(UiContext);
  if (!value) throw new Error("useUi must be used inside UiProvider");
  return value;
}

/** Translate common API and reader errors while retaining unknown details. */
export function translateErrorMessage(message: string, t: UiContextValue["t"]): string {
  const direct = t(message);
  if (direct !== message) return direct;
  if (/invalid username or password|invalid credentials/i.test(message)) return t("Invalid username or password");
  if (/request timed out/i.test(message)) return t("Request timed out");
  if (/could not load page/i.test(message)) return `${t("Could not load page")} ${message.match(/\(\d+\)/)?.[0] ?? ""}`.trim();
  return t("Something went wrong. Please try again.");
}

/** Translate an API/reader error by its stable code first, then its message. */
export function translateError(error: unknown, t: UiContextValue["t"]): string {
  if (typeof error === "string") return translateErrorMessage(error, t);
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value.code === "string" ? value.code : "";
    const codeKeys: Record<string, string> = {
      invalid_credentials: "Invalid username or password",
      not_found: "The requested resource was not found",
      internal_error: "An internal server error occurred",
      validation_error: "Something went wrong. Please try again.",
      content_changed: "The book changed; refresh before continuing.",
      section_name_taken: "A section with that name already exists",
      series_name_taken: "A series with that name already exists in this section",
      scan_in_progress: "Scanning…",
      system_section: "The system section cannot be changed",
      book_present: "Only a missing book record can be removed",
      invalid_destination: "Choose exactly one destination",
    };
    const key = codeKeys[code];
    if (key) return t(key);
    if (typeof value.message === "string") return translateErrorMessage(value.message, t);
  }
  return t("Something went wrong. Please try again.");
}
