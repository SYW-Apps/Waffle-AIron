import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../ui';
import { useSettings } from '../settings';
import {
  createCustomThemeCopy,
  createCustomThemeFrom,
  DEFAULT_THEME_ID,
  getThemeOption,
  normalizeCustomTheme,
  resolveMode,
  resolveThemeVariables,
  type CustomTheme,
  type ResolvedMode,
  type ThemeModeVariableMap,
  type ThemeVariableMap,
  type ThemeVariableName,
} from '../theme/themes';
import { colorToHex, findClosestAccessibleColor, getContrastRatio, parseCssColor } from '../theme/colorUtils';

/**
 * The custom theme builder, ported from the SYW Apps shell's ThemeBuilderPanel
 * and adapted to wairon's fully-derived theme engine: a custom theme is sparse
 * overrides layered over the palette derived from its primary (see
 * theme/themes.ts), so every field here shows the RESOLVED value and editing it
 * records an override — with a per-field reset back to "derived". Edits stage
 * in a local draft; nothing persists (or applies to the document) until Save.
 * The reference's canvas-image upload is not ported — wairon's canvas themes
 * itself through the canvasBridge var overlay, not a background image.
 */

type FieldKind = 'color' | 'shadow' | 'text';

interface FieldSpec {
  key: ThemeVariableName;
  label: string;
  kind: FieldKind;
  group: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { key: '--wairon-primary', label: 'Primary', kind: 'color', group: 'Brand' },
  { key: '--wairon-primary-strong', label: 'Primary strong', kind: 'color', group: 'Brand' },
  { key: '--wairon-primary-contrast', label: 'Primary contrast', kind: 'color', group: 'Brand' },
  { key: '--wairon-secondary', label: 'Secondary', kind: 'color', group: 'Brand' },
  { key: '--wairon-accent', label: 'Accent', kind: 'color', group: 'Brand' },
  { key: '--wairon-brand-text-bg', label: 'Brand gradient', kind: 'text', group: 'Brand' },

  { key: '--wairon-page-bg', label: 'Page background', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-app-bg', label: 'App background', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-panel-bg', label: 'Panel', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-panel-bg-strong', label: 'Panel strong', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-panel-bg-soft', label: 'Panel soft', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-panel-bg-hover', label: 'Panel hover', kind: 'color', group: 'Surfaces' },
  { key: '--wairon-header-bg', label: 'Header background', kind: 'text', group: 'Surfaces' },
  { key: '--wairon-sidebar-bg', label: 'Sidebar background', kind: 'text', group: 'Surfaces' },
  { key: '--wairon-menu-bg', label: 'Menu background', kind: 'text', group: 'Surfaces' },
  { key: '--wairon-section-bg', label: 'Section background', kind: 'text', group: 'Surfaces' },

  { key: '--wairon-text', label: 'Text', kind: 'color', group: 'Text' },
  { key: '--wairon-text-muted', label: 'Text muted', kind: 'color', group: 'Text' },
  { key: '--wairon-text-subtle', label: 'Text subtle', kind: 'color', group: 'Text' },
  { key: '--wairon-text-inverse', label: 'Text inverse', kind: 'color', group: 'Text' },

  { key: '--wairon-border', label: 'Border', kind: 'color', group: 'Borders & effects' },
  { key: '--wairon-border-strong', label: 'Border strong', kind: 'color', group: 'Borders & effects' },
  { key: '--wairon-border-muted', label: 'Border muted', kind: 'color', group: 'Borders & effects' },
  { key: '--wairon-shadow', label: 'Shadow', kind: 'shadow', group: 'Borders & effects' },
  { key: '--wairon-shell-shadow', label: 'Shell shadow', kind: 'shadow', group: 'Borders & effects' },
  { key: '--wairon-focus-ring', label: 'Focus ring', kind: 'shadow', group: 'Borders & effects' },

  { key: '--wairon-ok', label: 'OK', kind: 'color', group: 'Status' },
  { key: '--wairon-warn', label: 'Warning', kind: 'color', group: 'Status' },
  { key: '--wairon-bad', label: 'Error', kind: 'color', group: 'Status' },
];

const GROUPS = Array.from(new Set(FIELD_SPECS.map((f) => f.group)));

const MODE_OPTIONS: Array<{ id: ResolvedMode; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'high-contrast', label: 'Contrast' },
];

/** Surfaces + text + borders: the tokens worth pinning per mode. */
const MODE_OVERRIDE_KEYS: ThemeVariableName[] = [
  '--wairon-page-bg',
  '--wairon-app-bg',
  '--wairon-panel-bg',
  '--wairon-panel-bg-strong',
  '--wairon-panel-bg-soft',
  '--wairon-panel-bg-hover',
  '--wairon-header-bg',
  '--wairon-sidebar-bg',
  '--wairon-menu-bg',
  '--wairon-section-bg',
  '--wairon-text',
  '--wairon-text-muted',
  '--wairon-text-subtle',
  '--wairon-text-inverse',
  '--wairon-border',
  '--wairon-border-strong',
  '--wairon-border-muted',
];

const SHADOW_PRESETS: Record<string, string> = {
  none: 'none',
  subtle: '0 1px 2px rgba(0, 0, 0, 0.14)',
  soft: '0 4px 14px rgba(0, 0, 0, 0.18)',
  medium: '0 8px 24px rgba(0, 0, 0, 0.24)',
  strong: '0 16px 40px rgba(0, 0, 0, 0.32)',
  glow: '0 0 0 1px rgba(var(--wairon-primary-rgb), 0.35), 0 0 24px rgba(var(--wairon-primary-rgb), 0.22)',
};

const cloneTheme = (theme: CustomTheme): CustomTheme => ({
  ...theme,
  swatches: [...theme.swatches] as [string, string, string],
  variables: { ...theme.variables },
  modeVariables: Object.fromEntries(
    Object.entries(theme.modeVariables ?? {}).map(([m, v]) => [m, { ...v }]),
  ) as ThemeModeVariableMap,
});

const sortEntries = (map: ThemeVariableMap | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;

/** Canonical serialization for the dirty check (key order independent). */
const serializeThemes = (themes: CustomTheme[]): string =>
  JSON.stringify(
    themes.map((t) => ({
      ...t,
      variables: sortEntries(t.variables),
      modeVariables: Object.fromEntries(
        Object.entries(t.modeVariables ?? {}).map(([m, v]) => [m, sortEntries(v)]),
      ),
    })),
  );

/* ── Field editors ──────────────────────────────────────────────────────── */

function ColorField(props: { value: string; onChange: (next: string) => void }) {
  const parsed = parseCssColor(props.value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const shownHex = colorToHex(props.value, '#000000');
  const setPickerColor = (nextHex: string) => {
    const rgb = parseCssColor(nextHex);
    if (!rgb) return;
    props.onChange(parsed.a < 1 ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${parsed.a.toFixed(2)})` : nextHex);
  };
  const setAlpha = (next: number) => {
    const a = Math.min(1, Math.max(0, next));
    props.onChange(a >= 1 ? shownHex : `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${a.toFixed(2)})`);
  };
  return (
    <div className="tb-color">
      <input type="color" className="tb-color-pick" value={shownHex} onChange={(e) => setPickerColor(e.target.value)} />
      <div className="tb-color-body">
        <input
          className="tb-input tb-mono"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="HEX, rgba(), or hsl()"
        />
        <div className="tb-alpha">
          <input type="range" min="0" max="1" step="0.01" value={parsed.a} onChange={(e) => setAlpha(Number.parseFloat(e.target.value))} />
          <span className="hint">{Math.round(parsed.a * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

function ShadowField(props: { value: string; onChange: (next: string) => void }) {
  const matchedPreset = Object.entries(SHADOW_PRESETS).find(([, v]) => v === props.value)?.[0];
  const [manual, setManual] = useState(!matchedPreset);
  const select = manual ? 'custom' : (matchedPreset ?? 'custom');
  return (
    <div className="tb-shadow">
      <select
        className="tb-input"
        value={select}
        onChange={(e) => {
          const next = e.target.value;
          setManual(next === 'custom');
          if (next !== 'custom') props.onChange(SHADOW_PRESETS[next]);
        }}
      >
        {Object.keys(SHADOW_PRESETS).map((name) => (
          <option key={name} value={name}>
            {name[0].toUpperCase() + name.slice(1)}
          </option>
        ))}
        <option value="custom">Custom</option>
      </select>
      <input
        className="tb-input tb-mono"
        value={props.value}
        onChange={(e) => {
          setManual(true);
          props.onChange(e.target.value);
        }}
        placeholder="box-shadow CSS"
        style={{ boxShadow: props.value || SHADOW_PRESETS.soft }}
      />
    </div>
  );
}

function Field(props: {
  label: string;
  kind: FieldKind;
  value: string;
  overridden: boolean;
  onChange: (next: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="tb-field">
      <div className="tb-field-head">
        <span className="tb-field-label">{props.label}</span>
        {props.overridden ? (
          <button className="tb-clear" onClick={props.onClear} title="Remove the override — derive from the primary again">
            custom ↺
          </button>
        ) : (
          <span className="tb-derived">derived</span>
        )}
      </div>
      {props.kind === 'color' && <ColorField value={props.value} onChange={props.onChange} />}
      {props.kind === 'shadow' && <ShadowField value={props.value} onChange={props.onChange} />}
      {props.kind === 'text' && (
        <input className="tb-input tb-mono" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      )}
    </div>
  );
}

function TextSample(props: { label: string; text: string; background: string }) {
  const ratio = getContrastRatio(colorToHex(props.text, '#ffffff'), colorToHex(props.background, '#000000'));
  return (
    <div className="tb-sample" style={{ background: props.background, color: props.text }}>
      <div className="tb-sample-label">{props.label}</div>
      <div className="tb-sample-main">Primary text sample</div>
      <div className="tb-sample-sub">
        Secondary text sample — {ratio.toFixed(1)}:1 {ratio >= 4.5 ? '✓ AA' : '✕ below AA'}
      </div>
    </div>
  );
}

/* ── The view ───────────────────────────────────────────────────────────── */

export function ThemeBuilder() {
  const { themeId, appearance, customThemes, setThemeId, setCustomThemes } = useSettings();
  const toast = useToast();

  const stored = useMemo(() => customThemes.map(cloneTheme).map(normalizeCustomTheme), [customThemes]);
  const storedSnapshot = useMemo(() => serializeThemes(stored), [stored]);
  const [draftThemes, setDraftThemes] = useState<CustomTheme[]>(() => stored);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(() => stored[0]?.id ?? null);
  const lastStoredSnapshotRef = useRef(storedSnapshot);

  // Re-seed the draft when the stored library changes underneath us (save from
  // this view, or an edit from another part of the app).
  useEffect(() => {
    if (lastStoredSnapshotRef.current === storedSnapshot) return;
    lastStoredSnapshotRef.current = storedSnapshot;
    setDraftThemes(stored);
    setSelectedThemeId((prev) => (prev && stored.some((t) => t.id === prev) ? prev : (stored[0]?.id ?? null)));
  }, [stored, storedSnapshot]);

  const selected = useMemo(
    () => draftThemes.find((t) => t.id === selectedThemeId) ?? draftThemes[0] ?? null,
    [draftThemes, selectedThemeId],
  );

  const [previewMode, setPreviewMode] = useState<ResolvedMode>(resolveMode(appearance));
  const [modeEditMode, setModeEditMode] = useState<ResolvedMode>('light');
  const [seed, setSeed] = useState('#22ddff');

  useEffect(() => {
    if (!selected) return;
    setPreviewMode(selected.defaultMode);
    setModeEditMode(selected.defaultMode);
    setSeed(selected.swatches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const draftSnapshot = useMemo(() => serializeThemes(draftThemes.map(normalizeCustomTheme)), [draftThemes]);
  const isDirty = draftSnapshot !== storedSnapshot;
  const resolved = useMemo(
    () => (selected ? resolveThemeVariables(selected, previewMode) : null),
    [selected, previewMode],
  );

  const updateSelected = (updater: (theme: CustomTheme) => CustomTheme) => {
    if (!selected) return;
    setDraftThemes((themes) => themes.map((t) => (t.id === selected.id ? normalizeCustomTheme(updater(cloneTheme(t))) : t)));
  };

  const setVariable = (key: ThemeVariableName, value: string) =>
    updateSelected((t) => ({ ...t, variables: { ...t.variables, [key]: value } }));
  const clearVariable = (key: ThemeVariableName) =>
    updateSelected((t) => {
      const variables = { ...t.variables };
      delete variables[key];
      return { ...t, variables };
    });
  const setModeVariables = (mode: ResolvedMode, patch: ThemeVariableMap) =>
    updateSelected((t) => ({
      ...t,
      modeVariables: { ...(t.modeVariables ?? {}), [mode]: { ...(t.modeVariables?.[mode] ?? {}), ...patch } },
    }));
  const clearModeVariable = (mode: ResolvedMode, key: ThemeVariableName) =>
    updateSelected((t) => {
      const forMode = { ...(t.modeVariables?.[mode] ?? {}) };
      delete forMode[key];
      return { ...t, modeVariables: { ...(t.modeVariables ?? {}), [mode]: forMode } };
    });

  const createFromActive = () => {
    const draft = createCustomThemeFrom(getThemeOption(themeId, draftThemes), resolveMode(appearance));
    setDraftThemes((themes) => [...themes, draft]);
    setSelectedThemeId(draft.id);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy = createCustomThemeCopy(selected);
    setDraftThemes((themes) => [...themes, copy]);
    setSelectedThemeId(copy.id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    setDraftThemes((themes) => {
      const next = themes.filter((t) => t.id !== selected.id);
      setSelectedThemeId((cur) => (cur === selected.id ? (next[0]?.id ?? null) : cur));
      return next;
    });
  };

  // "Derive full palette": drop every override so the entire palette re-derives
  // from the seed color (the sparse-override equivalent of the reference's
  // fill-all-tokens derive).
  const deriveFromSeed = () =>
    updateSelected((t) => ({
      ...t,
      swatches: [seed, t.swatches[1], t.swatches[2]],
      variables: {},
      modeVariables: {},
    }));

  // Accessibility pass (the reference's "EAA text set", adapted): pin the text
  // tokens for the PREVIEWED mode to WCAG-AA (4.5:1) against the resolved
  // backgrounds, stored as regular mode overrides.
  const applyAccessibleTextSet = () => {
    if (!selected || !resolved) return;
    const pageBg = colorToHex(resolved['--wairon-page-bg'], '#0b1120');
    const panelBg = colorToHex(resolved['--wairon-panel-bg'], pageBg);
    const primary = colorToHex(resolved['--wairon-primary'], '#22ddff');
    const contrastSeed = getContrastRatio('#ffffff', primary) >= getContrastRatio('#000000', primary) ? '#ffffff' : '#000000';
    setModeVariables(previewMode, {
      '--wairon-text': findClosestAccessibleColor(colorToHex(resolved['--wairon-text'], '#f9fafb'), pageBg, 4.5),
      '--wairon-text-muted': findClosestAccessibleColor(colorToHex(resolved['--wairon-text-muted'], '#cbd5e1'), panelBg, 4.5),
      '--wairon-text-subtle': findClosestAccessibleColor(colorToHex(resolved['--wairon-text-subtle'], '#94a3b8'), panelBg, 4.5),
      '--wairon-primary-contrast': findClosestAccessibleColor(contrastSeed, primary, 4.5),
    });
  };

  const handleSave = () => {
    const normalized = draftThemes.map(normalizeCustomTheme);
    setCustomThemes(normalized);
    // Only reclaim the ACTIVE slot when it pointed at a custom theme that no
    // longer exists — never hijack an active built-in.
    if (themeId.startsWith('custom:') && !normalized.some((t) => t.id === themeId)) {
      setThemeId(DEFAULT_THEME_ID);
    }
    toast.ok('Custom themes saved');
  };

  const handleReset = () => {
    setDraftThemes(stored);
    setSelectedThemeId((cur) => (cur && stored.some((t) => t.id === cur) ? cur : (stored[0]?.id ?? null)));
  };

  const activeOption = getThemeOption(themeId, draftThemes);

  return (
    <div className="view-pad tb-view">
      <div className="view-head">
        <div>
          <h2>Theme builder</h2>
          <p className="hint">
            Custom themes are stored in this browser and layer your edits over the palette derived from the primary
            color. Changes stage locally until you save.
          </p>
        </div>
      </div>

      <div className="tb-layout">
        <aside className="panel tb-side">
          <div className="tb-side-head">
            <strong>Custom themes</strong>
            <span className="hint">{draftThemes.length} local {draftThemes.length === 1 ? 'draft' : 'drafts'}</span>
          </div>
          <button className="btn tb-new" onClick={createFromActive}>
            ＋ New from active theme
          </button>
          <div className="tb-list">
            {draftThemes.length === 0 && <div className="tb-empty hint">No custom themes yet.</div>}
            {draftThemes.map((t) => (
              <button
                key={t.id}
                className={`theme-opt ${t.id === selected?.id ? 'is-active' : ''}`}
                onClick={() => setSelectedThemeId(t.id)}
              >
                <span className="swatches">
                  {t.swatches.map((c, i) => (
                    <span key={`${i}-${c}`} style={{ background: c }} />
                  ))}
                </span>
                <span className="cell-stack">
                  <span className="theme-name">{t.label}</span>
                  <span className="hint">{t.defaultMode} mode</span>
                </span>
                {t.id === themeId && <span className="check">✓</span>}
              </button>
            ))}
          </div>
        </aside>

        <section className="panel tb-main">
          {!selected ? (
            <div className="tb-empty-main hint">Create a custom theme to edit its palette here.</div>
          ) : (
            <>
              <div className="tb-head">
                <div className="tb-head-fields">
                  <label className="tb-field">
                    <span className="tb-field-label">Name</span>
                    <input
                      className="tb-input"
                      value={selected.label}
                      onChange={(e) => updateSelected((t) => ({ ...t, label: e.target.value }))}
                    />
                  </label>
                  <label className="tb-field">
                    <span className="tb-field-label">Description</span>
                    <input
                      className="tb-input"
                      value={selected.description}
                      onChange={(e) => updateSelected((t) => ({ ...t, description: e.target.value }))}
                    />
                  </label>
                  <div className="tb-field">
                    <span className="tb-field-label">Default mode</span>
                    <div className="seg">
                      {MODE_OPTIONS.map((m) => (
                        <button
                          key={m.id}
                          className={`seg-btn ${selected.defaultMode === m.id ? 'is-active' : ''}`}
                          onClick={() => updateSelected((t) => ({ ...t, defaultMode: m.id }))}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="tb-head-actions">
                  <button className="btn" onClick={() => setThemeId(selected.id)} disabled={themeId === selected.id}>
                    {themeId === selected.id ? '✓ Active' : 'Use theme'}
                  </button>
                  <button className="btn btn-ghost" onClick={duplicateSelected}>
                    Duplicate
                  </button>
                  <button className="btn btn-danger" onClick={deleteSelected}>
                    Delete
                  </button>
                </div>
              </div>

              <section className="tb-block">
                <div className="tb-block-head">
                  <div>
                    <div className="tb-block-title">Seed</div>
                    <p className="hint">
                      Derive the whole palette from one primary color. This clears every override so all tokens follow
                      the seed again.
                    </p>
                  </div>
                </div>
                <div className="tb-seed">
                  <input type="color" className="tb-seed-pick" value={colorToHex(seed, '#22ddff')} onChange={(e) => setSeed(e.target.value)} />
                  <button className="btn btn-primary" onClick={deriveFromSeed}>
                    Derive full palette
                  </button>
                </div>
              </section>

              <section className="tb-block">
                <div className="tb-block-head">
                  <div>
                    <div className="tb-block-title">Preview mode</div>
                    <p className="hint">Editors and previews below resolve the theme in this appearance mode.</p>
                  </div>
                  <div className="seg tb-seg">
                    {MODE_OPTIONS.map((m) => (
                      <button
                        key={m.id}
                        className={`seg-btn ${previewMode === m.id ? 'is-active' : ''}`}
                        onClick={() => setPreviewMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {GROUPS.map((group) => (
                <section key={group} className="tb-block">
                  <div className="tb-block-title">{group}</div>
                  <div className="tb-grid">
                    {FIELD_SPECS.filter((f) => f.group === group).map((f) => (
                      <Field
                        key={`${selected.id}:${f.key}`}
                        label={f.label}
                        kind={f.kind}
                        value={selected.variables[f.key] ?? resolved?.[f.key] ?? ''}
                        overridden={selected.variables[f.key] !== undefined}
                        onChange={(next) => setVariable(f.key, next)}
                        onClear={() => clearVariable(f.key)}
                      />
                    ))}
                  </div>
                  {group === 'Surfaces' && resolved && (
                    <div className="tb-strip">
                      {(['--wairon-page-bg', '--wairon-panel-bg', '--wairon-header-bg'] as ThemeVariableName[]).map((k) => (
                        <div key={k} className="tb-strip-swatch" style={{ background: resolved[k] }} title={k} />
                      ))}
                    </div>
                  )}
                  {group === 'Text' && resolved && (
                    <>
                      <div className="tb-block-head tb-acc-head">
                        <p className="hint">
                          Pin WCAG-AA (4.5:1) text colors for the previewed mode against its resolved backgrounds,
                          stored as mode overrides.
                        </p>
                        <button className="btn btn-ghost btn-sm" onClick={applyAccessibleTextSet}>
                          Generate accessible text set
                        </button>
                      </div>
                      <div className="tb-strip">
                        <TextSample label="Page text" text={resolved['--wairon-text']} background={resolved['--wairon-page-bg']} />
                        <TextSample label="Panel text" text={resolved['--wairon-text-muted']} background={resolved['--wairon-panel-bg']} />
                        <TextSample label="Primary button" text={resolved['--wairon-primary-contrast']} background={resolved['--wairon-primary']} />
                      </div>
                    </>
                  )}
                </section>
              ))}

              <section className="tb-block">
                <div className="tb-block-head">
                  <div>
                    <div className="tb-block-title">Mode overrides</div>
                    <p className="hint">
                      Pin surface, text, and border tokens for one appearance mode; anything left derived keeps
                      following the primary per mode.
                    </p>
                  </div>
                  <div className="seg tb-seg">
                    {MODE_OPTIONS.map((m) => (
                      <button
                        key={m.id}
                        className={`seg-btn ${modeEditMode === m.id ? 'is-active' : ''}`}
                        onClick={() => setModeEditMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="tb-grid">
                  {MODE_OVERRIDE_KEYS.map((key) => {
                    const spec = FIELD_SPECS.find((f) => f.key === key);
                    const override = selected.modeVariables?.[modeEditMode]?.[key];
                    const value = override ?? resolveThemeVariables(selected, modeEditMode)[key] ?? '';
                    return (
                      <Field
                        key={`${selected.id}:${modeEditMode}:${key}`}
                        label={spec?.label ?? key}
                        kind={spec?.kind ?? 'color'}
                        value={value}
                        overridden={override !== undefined}
                        onChange={(next) => setModeVariables(modeEditMode, { [key]: next })}
                        onClear={() => clearModeVariable(modeEditMode, key)}
                      />
                    );
                  })}
                </div>
              </section>

              <div className="tb-foot">
                <span className="hint">Active theme: {activeOption.label}</span>
                <button className="btn btn-primary" onClick={() => setThemeId(selected.id)}>
                  Set active theme
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {isDirty && (
        <div className="savebar">
          <span className="savebar-icon">⚠</span>
          <div className="cell-stack">
            <strong>Unsaved theme changes</strong>
            <span className="hint">Staged locally until you save.</span>
          </div>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={handleReset}>
            Reset
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            Save changes
          </button>
        </div>
      )}
    </div>
  );
}
