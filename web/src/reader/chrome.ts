export type ReaderChrome = {
  mobile: boolean;
  toolbarVisible: boolean;
  settingsOpen: boolean;
  navigationOpen: boolean;
};

/** Center tap shows or hides the title bar. An open settings bar or chapter drawer closes first. */
export function chromeAfterCenterTap(state: ReaderChrome): ReaderChrome {
  if (!state.mobile) return state;
  if (state.settingsOpen || state.navigationOpen) {
    return { ...state, settingsOpen: false, navigationOpen: false, toolbarVisible: true };
  }
  return { ...state, toolbarVisible: !state.toolbarVisible };
}
