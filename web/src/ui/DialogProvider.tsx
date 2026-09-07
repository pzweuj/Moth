import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useUi } from "../i18n";

type DialogKind = "prompt" | "confirm" | "alert";
type DialogState = {
  kind: DialogKind;
  title?: string;
  message: string;
  value?: string;
};

type DialogApi = {
  prompt: (message: string, value?: string, title?: string) => Promise<string | null>;
  confirm: (message: string, title?: string) => Promise<boolean>;
  alert: (message: string, title?: string) => Promise<void>;
};
type DialogResult = string | boolean | null | undefined;

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useUi();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const resolverRef = useRef<((value: DialogResult) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const rememberFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) returnFocusRef.current = active;
  };

  const close = (value: string | boolean | null | undefined) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    resolver?.(value);
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    // Wait until the dialog has been removed so focus is not immediately
    // stolen back by the unmounting control.
    queueMicrotask(() => returnFocus?.focus());
  };
  const api: DialogApi = {
    prompt: (message, value = "", title) => new Promise((resolve) => {
      rememberFocus();
      resolverRef.current = (result) => resolve(typeof result === "string" || result === null ? result : null);
      setDialog({ kind: "prompt", message, value, title });
    }),
    confirm: (message, title) => new Promise((resolve) => {
      rememberFocus();
      resolverRef.current = (result) => resolve(result === true);
      setDialog({ kind: "confirm", message, title });
    }),
    alert: (message, title) => new Promise((resolve) => {
      rememberFocus();
      resolverRef.current = () => resolve();
      setDialog({ kind: "alert", message, title });
    }),
  };

  useEffect(() => {
    if (!dialog) return;
    if (dialog.kind === "prompt") inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(dialog.kind === "prompt" ? null : false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="moth-dialog-title"
            aria-describedby="moth-dialog-message"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="moth-dialog-title">{dialog.title ?? t(dialog.kind === "prompt" ? "Edit" : dialog.kind === "confirm" ? "Please confirm" : "Notice")}</h2>
            <p id="moth-dialog-message">{dialog.message}</p>
            {dialog.kind === "prompt" && (
              <input
                ref={inputRef}
                className="dialog-input"
                value={dialog.value ?? ""}
                onChange={(event) => setDialog((current) => current ? { ...current, value: event.target.value } : current)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") close(dialog.value?.trim() || null);
                }}
                aria-label={t("Name")}
              />
            )}
            <div className="dialog-actions">
              {dialog.kind !== "alert" && (
                <button className="quiet-button" type="button" onClick={() => close(dialog.kind === "prompt" ? null : false)}>
                  {t("Cancel")}
                </button>
              )}
              <button
                className="primary-button compact-button"
                type="button"
                onClick={() => close(dialog.kind === "prompt" ? dialog.value?.trim() || null : dialog.kind === "confirm" ? true : undefined)}
              >
                {t(dialog.kind === "prompt" ? "Save" : dialog.kind === "confirm" ? "Confirm" : "OK")}
              </button>
            </div>
          </section>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const value = useContext(DialogContext);
  if (!value) throw new Error("useDialog must be used inside DialogProvider");
  return value;
}
