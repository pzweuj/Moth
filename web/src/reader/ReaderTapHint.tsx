import { useEffect, useState } from "react";
import { useUi } from "../i18n";
import { isMobileReadingLayout } from "./readerInteractions";

const STORAGE_KEY = "moth:reader-tap-hint-seen";

function wasSeen(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // The hint remains dismissible for this render when storage is blocked.
  }
}

/** A one-time, unobtrusive explanation of the left/right page tap zones. */
export function ReaderTapHint() {
  const { t } = useUi();
  const [mobile, setMobile] = useState(() => isMobileReadingLayout());
  const [visible, setVisible] = useState(() => !wasSeen());

  useEffect(() => {
    const onResize = () => setMobile(isMobileReadingLayout());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!visible || !mobile) return;
    const timer = window.setTimeout(() => {
      markSeen();
      setVisible(false);
    }, 5500);
    return () => window.clearTimeout(timer);
  }, [mobile, visible]);

  if (!visible || !mobile) return null;
  return (
    <div className="reader-tap-hint" role="status">
      <span>{t("Tap the left or right side to turn the page")}</span>
      <button type="button" onClick={() => { markSeen(); setVisible(false); }}>{t("Got it")}</button>
    </div>
  );
}
