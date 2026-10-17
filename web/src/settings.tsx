import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  applyTheme,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  sanitizeCustomThemes,
  type AppearanceMode,
  type CustomTheme,
} from './theme/themes';

/**
 * User UI preferences (theme, appearance mode, sidebar collapse) persisted to
 * localStorage and applied to the document. Mirrors the SYW Apps shell's
 * configurability so the app remembers a user's look across sessions. Custom
 * themes (theme builder) ride the same key — they are app-level state, not
 * account state.
 */
interface Settings {
  themeId: string;
  appearance: AppearanceMode;
  sidebarCollapsed: boolean;
  customThemes: CustomTheme[];
  setThemeId: (id: string) => void;
  setAppearance: (mode: AppearanceMode) => void;
  toggleSidebar: () => void;
  setCustomThemes: (themes: CustomTheme[]) => void;
}

const STORAGE_KEY = 'wairon-ui-settings';

interface Persisted {
  themeId: string;
  appearance: AppearanceMode;
  sidebarCollapsed: boolean;
  customThemes: CustomTheme[];
}

function load(): Persisted {
  const fallback: Persisted = {
    themeId: DEFAULT_THEME_ID,
    appearance: DEFAULT_APPEARANCE,
    sidebarCollapsed: false,
    customThemes: [],
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = { ...fallback, ...(JSON.parse(raw) as Partial<Persisted>) };
    parsed.customThemes = sanitizeCustomThemes(parsed.customThemes);
    return parsed;
  } catch {
    return fallback;
  }
}

const SettingsContext = createContext<Settings | null>(null);
export const useSettings = (): Settings => {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(load);

  // Apply the theme whenever the palette, mode, or custom-theme library changes.
  useEffect(() => {
    applyTheme(state.themeId, state.appearance, state.customThemes);
  }, [state.themeId, state.appearance, state.customThemes]);

  // Re-derive on OS color-scheme change while in 'system' mode.
  useEffect(() => {
    if (state.appearance !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(state.themeId, state.appearance, state.customThemes);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [state.appearance, state.themeId, state.customThemes]);

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [state]);

  const setThemeId = useCallback((themeId: string) => setState((s) => ({ ...s, themeId })), []);
  const setAppearance = useCallback((appearance: AppearanceMode) => setState((s) => ({ ...s, appearance })), []);
  const toggleSidebar = useCallback(() => setState((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed })), []);
  const setCustomThemes = useCallback((customThemes: CustomTheme[]) => setState((s) => ({ ...s, customThemes })), []);

  return (
    <SettingsContext.Provider value={{ ...state, setThemeId, setAppearance, toggleSidebar, setCustomThemes }}>
      {children}
    </SettingsContext.Provider>
  );
}
