import { useEffect, useRef, useState } from 'react';
import { useSettings } from './settings';
import { ThemeMenu } from './components/ThemeMenu';
import {
  APPEARANCE_OPTIONS,
  buildThemeOptions,
  createCustomThemeFrom,
  getThemeOption,
  resolveMode,
  type AppearanceMode,
} from './theme/themes';

/**
 * The theme settings, extracted from HeaderMenu so they are usable WITHOUT a
 * signed-in session: settings are app-level (localStorage-backed), not account
 * state. `ThemeSections` binds wairon's settings store to the reusable
 * `ThemeMenu` component (the compact dropdown + modes picker shared across SYW
 * apps); `ThemeCog` is a standalone floating cog + popover for chromeless
 * surfaces (the sign-in screen, local dev mode).
 *
 * `onOpenBuilder` (optional) enables the create/manage affordances: passed only
 * where the /themes route is reachable (the hosted shell), so the login screen
 * and local dev keep a select-only picker while still listing saved customs.
 */
export function ThemeSections(props: { onOpenBuilder?: () => void }) {
  const { themeId, appearance, customThemes, setThemeId, setAppearance, setCustomThemes } = useSettings();

  // Mirrors the reference shell's on-ramp: snapshot the active theme as a new
  // custom theme, activate it, and jump into the builder to edit it.
  const createFromActive = () => {
    const draft = createCustomThemeFrom(getThemeOption(themeId, customThemes), resolveMode(appearance));
    setCustomThemes([...customThemes, draft]);
    setThemeId(draft.id);
    props.onOpenBuilder?.();
  };

  return (
    <div className="hmenu-section">
      <ThemeMenu
        themeId={themeId}
        appearance={appearance}
        options={buildThemeOptions(customThemes).map((t) => ({
          ...t,
          description: t.description || 'Custom theme',
        }))}
        modes={APPEARANCE_OPTIONS}
        onSelectTheme={setThemeId}
        onSelectMode={(m) => setAppearance(m as AppearanceMode)}
        onCreateTheme={props.onOpenBuilder ? createFromActive : undefined}
        onManageThemes={props.onOpenBuilder}
      />
    </div>
  );
}

export function ThemeCog() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="hmenu theme-cog" ref={ref}>
      <button
        className={`hmenu-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme settings"
        title="Theme settings"
      >
        <span className="cog">⚙</span>
      </button>
      {open && (
        <div className="hmenu-pop" role="menu">
          <ThemeSections />
        </div>
      )}
    </div>
  );
}
