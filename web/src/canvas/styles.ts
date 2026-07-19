/* GENERATED — do not edit. */
export const CANVAS_CSS = `/* GENERATED from src/core/canvas.ts by scripts/gen-canvas-engine.mjs — do not edit. */
:host { display:block; width:100%; height:100%; }
.cbody { display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; }
/* SYW Apps Standardized Global CSS (inlined for offline use) */
:host, .cbody {
  --syw-cyan: #22ddff;
  --syw-purple: #8b5cf6;
  --syw-yellow: #ddff22;
  --syw-amber: #f59e0b;
  --syw-bg: #0a0a0f;
  --syw-deep-space: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
  --syw-surface: rgba(13, 27, 42, 0.95);
  --syw-primary-gradient: linear-gradient(135deg, #22ddff 0%, #8b5cf6 100%);
  --syw-secondary-gradient: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  --syw-surface-gradient: linear-gradient(135deg, rgba(13, 27, 42, 0.95) 0%, rgba(27, 38, 59, 0.98) 100%);
  --syw-glow: 0 0 20px rgba(34, 221, 255, 0.3);
  --syw-deep-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.syw-gradient-text { background: var(--syw-primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; display: inline-block; }
* { box-sizing: border-box; }

.cbody[data-theme="syw"] {
  --bg: var(--syw-bg);
  --chrome: #0e1a2b;
  --chrome-border: rgba(34, 221, 255, 0.22);
  --ink: #e8ecf3;
  --dim: #9db0c7;
  --line: rgba(255,255,255,0.12);
  --input-bg: rgba(255,255,255,0.07);
  --hover-bg: rgba(34, 221, 255, 0.12);
  --accent: var(--syw-cyan);
  --card: rgba(255,255,255,0.05);
  --danger: #ff6b81; --warn: #f59e0b;
}
.cbody[data-theme="light"] {
  --bg: #f2f5f8;
  --chrome: #ffffff;
  --chrome-border: #cfd8e1;
  --ink: #1f2328;
  --dim: #4d5761;
  --line: #dde4ea;
  --input-bg: #f1f4f7;
  --hover-bg: rgba(74, 125, 207, 0.10);
  --accent: #3465b4;
  --card: #f7fafc;
  --danger: #c22f3e; --warn: #9a6a00;
}
.cbody { margin:0; position:relative; background:var(--bg); color:var(--ink); font:13px/1.45 "Inter", system-ui, "Segoe UI", sans-serif; overflow:hidden; }
.cbody[data-theme="syw"] { background-image: var(--syw-deep-space); background-attachment: fixed; }

/* Floating header: the toolbar hovers over a FULL-BLEED canvas (blueprint-
   designer style) instead of reserving a solid top bar. It anchors to the .cbody
   (position:relative there) and yields to the details panel when that is open. */
header { flex:0 0 auto; display:flex; align-items:center; gap:10px; padding:0 14px; height:52px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:12px; box-shadow:var(--syw-deep-shadow); position:absolute; top:10px; left:12px; right:12px; z-index:20; overflow-x:auto; scrollbar-width:thin; }
.cbody:not(.panel-closed) header { right:calc(var(--panel-width, 380px) + 19px); }
/* Responsive overflow: on a narrow header the toolbar buttons must stay
   REACHABLE (scroll) rather than wrapping off the right edge. Groups keep their
   own shape; nothing shrinks below its content width. */
header > * { flex:0 0 auto; }
header .toolbar, header .tabs, header .grp { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
header .brand { font-weight:800; font-size:17px; letter-spacing:.02em; }
#crumbs { display:flex; align-items:center; gap:4px; max-width:34vw; overflow-x:auto; white-space:nowrap; scrollbar-width:thin; }
#crumbs .crumb { border:none; background:transparent; color:var(--dim); cursor:pointer; font:inherit; font-size:12.5px; padding:4px 7px; border-radius:7px; }
#crumbs .crumb:hover { background:var(--hover-bg); color:var(--ink); }
#crumbs .crumb.cur { color:var(--ink); font-weight:700; cursor:default; }
#crumbs .sep { color:var(--dim); font-size:11px; }
header .divider { width:1px; height:24px; background:var(--line); margin:0 2px; }
header input[type="search"] { padding:6px 10px; border:1px solid var(--chrome-border); border-radius:8px; width:170px; font:inherit; background:var(--input-bg); color:var(--ink); }
header input[type="search"]::placeholder { color:var(--dim); }
.switch { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--dim); font-size:12px; white-space:nowrap; user-select:none; padding:5px 8px; border-radius:8px; }
.switch:hover { background:var(--hover-bg); color:var(--ink); }
.switch input { accent-color:var(--accent); margin:0; }
.tbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--ink); padding:6px 11px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap; }
.tbtn:hover { background:var(--hover-bg); border-color:var(--accent); }
.spacer { flex:1; }
.seg { display:flex; border:1px solid var(--chrome-border); border-radius:8px; overflow:hidden; }
.seg button { border:none; background:transparent; color:var(--dim); padding:5px 11px; cursor:pointer; font:inherit; font-size:12px; }
.seg button.active { background:var(--accent); color:#fff; font-weight:700; }

.dropdown { position:relative; }
/* Fixed (viewport-anchored) + JS-positioned on open, so the menu overlays the
   whole page and is NEVER clipped by the header's overflow-x:auto (or, in the
   embedded canvas, the app's scroll container) — which would otherwise trap it
   inside the canvas and force a scrollbar. Position is set in wireDropdown. */
.dropdown .menu { display:none; position:fixed; max-height:calc(100vh - 80px); overflow-y:auto; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; box-shadow:var(--syw-deep-shadow); min-width:200px; padding:6px; z-index:120; }
/* Child combinator, deliberately: a dropdown moved INTO the "⋯" overflow menu
   must not auto-open when the More dropdown opens (a descendant selector would
   match every nested menu under .dropdown.open). */
.dropdown.open > .menu { display:block; }
.dropdown .menu button { display:block; width:100%; text-align:left; border:none; background:transparent; color:var(--ink); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; font-size:12.5px; }
.dropdown .menu button:hover { background:var(--hover-bg); }
.dropdown .menu .hint { display:block; color:var(--dim); font-size:10.5px; }
/* Header controls collapsed into the "⋯" overflow menu: whole items (buttons
   or nested dropdowns) stack vertically; a nested dropdown's own menu still
   opens fixed-positioned over the page. */
#moreMenu .dropdown { display:block; width:100%; }
#moreMenu .dropdown > .tbtn, #moreMenu > .tbtn { display:block; width:100%; text-align:left; border:none; background:transparent; margin:2px 0; }
#moreMenu .dropdown > .tbtn:hover, #moreMenu > .tbtn:hover { background:var(--hover-bg); }

/* Settings panel — toggle switches */
.settings-menu { min-width:266px; }
.swrow { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:7px 9px; border-radius:8px; cursor:pointer; user-select:none; }
.swrow:hover { background:var(--hover-bg); }
.swrow .lbl { font-size:12.5px; color:var(--ink); line-height:1.3; }
.swrow .lbl .sub { display:block; color:var(--dim); font-size:10.5px; font-weight:400; }
.selectWrap { position:relative; width:100%; }
.selectWrap::after { content:'\\25BE'; position:absolute; right:10px; top:50%; transform:translateY(-50%); color:var(--dim); pointer-events:none; font-size:10px; }
.selectControl { width:100%; appearance:none; -webkit-appearance:none; background:var(--input-bg); color:var(--ink); border:1px solid var(--chrome-border); border-radius:7px; padding:6px 30px 6px 9px; font-size:11.5px; font-family:inherit; outline:none; color-scheme:dark; }
.selectControl:hover { border-color:var(--accent); background:var(--hover-bg); }
.selectControl:focus { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent); }
.selectControl option { background:var(--chrome); color:var(--ink); }
.cbody[data-theme="light"] .selectControl { color-scheme:light; }
.toggle { position:relative; display:inline-block; width:36px; height:20px; flex:0 0 auto; }
.toggle input { position:absolute; opacity:0; width:0; height:0; margin:0; }
.toggle .track { position:absolute; inset:0; background:var(--input-bg); border:1px solid var(--chrome-border); border-radius:20px; transition:background .15s, border-color .15s; }
.toggle .track::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; background:var(--dim); border-radius:50%; transition:transform .15s, background .15s; }
.toggle input:checked + .track { background:var(--accent); border-color:var(--accent); }
.toggle input:checked + .track::after { transform:translateX(16px); background:#fff; }

#wrap { display:flex; height:100%; }
#stage { flex:1; min-width:0; position:relative; }
#cy { position:absolute; inset:0; }
.legend { position:absolute; left:12px; bottom:12px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:10px; padding:8px 12px; font-size:11px; color:var(--dim); z-index:5; pointer-events:none; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; border:1.5px solid; }
/* Stage overlays clear the floating header (52px + 10px top + 10px gap). The
   header hides in presentation mode, where they return to the top edge. */
.viewhint { position:absolute; top:72px; left:12px; color:var(--dim); font-size:11px; background:var(--chrome); border:1px solid var(--chrome-border); border-radius:9px; padding:5px 10px; z-index:5; pointer-events:none; }
.cbody.presentation .viewhint { top:10px; }
#typesWarn { position:absolute; top:72px; left:50%; transform:translateX(-50%); color:var(--ink); font-size:12px; background:var(--chrome); border:1px solid var(--warn); border-radius:9px; padding:6px 12px; z-index:6; max-width:72vw; box-shadow:var(--syw-deep-shadow); display:none; }
#typesWarn button { margin-left:8px; }

#panelResizer { flex:0 0 7px; cursor:col-resize; background:var(--chrome); border-left:1px solid var(--chrome-border); border-right:1px solid var(--line); z-index:11; position:relative; }
#panelResizer::after { content:''; position:absolute; top:50%; left:50%; width:2px; height:48px; transform:translate(-50%, -50%); border-radius:2px; background:var(--dim); opacity:.45; }
#panelResizer:hover::after, .cbody.resizing-panel #panelResizer::after { background:var(--accent); opacity:1; }
#panel { width:var(--panel-width, 380px); flex:0 0 var(--panel-width, 380px); border-left:1px solid var(--chrome-border); background:var(--chrome); overflow-y:auto; z-index:10; }
.cbody.panel-closed #panel, .cbody.panel-closed #panelResizer { display:none; }
.cbody.resizing-panel { cursor:col-resize; user-select:none; }
.cbody.resizing-panel #cy { pointer-events:none; }
.cbody:not(.panel-closed) #panelToggle { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
#panel .head { padding:16px 18px 10px; border-bottom:1px solid var(--line); }
#panel .head h2 { font-size:16px; margin:0 0 6px; }
#panel .body { padding:12px 18px 30px; }
#panel .chip { display:inline-block; padding:2px 9px; border-radius:11px; font-size:11px; border:1px solid var(--chrome-border); margin:0 4px 5px 0; background:var(--input-bg); color:var(--ink); }
#panel .chip[data-kind] { cursor:pointer; }
#panel .chip[data-kind]:hover { border-color:var(--accent); background:var(--hover-bg); }
#panel .desc { color:var(--dim); margin:8px 0 2px; }
#panel .openbtn { margin:6px 0 0; }
#panel details { border:1px solid var(--line); border-radius:10px; margin:10px 0; background:var(--card); overflow:hidden; }
#panel summary { cursor:pointer; padding:9px 12px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); user-select:none; display:flex; align-items:center; gap:8px; }
#panel summary:hover { color:var(--ink); background:var(--hover-bg); }
#panel summary .count { margin-left:auto; font-weight:600; background:var(--input-bg); border:1px solid var(--line); border-radius:9px; padding:0 7px; font-size:10.5px; }
#panel details > .inner { padding:4px 12px 12px; }
#panel .method { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:8px 0; background:var(--chrome); }
#panel .method .mname { font-weight:700; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#panel .method .mname .grow { flex:1; }
#panel .method code { font-size:11px; word-break:break-all; color:var(--dim); display:block; margin-top:3px; }
#panel .method .mdesc { color:var(--dim); font-size:12px; margin-top:3px; }
#panel .flowbtn { border:1px solid var(--chrome-border); background:var(--input-bg); color:var(--accent); font-size:10.5px; padding:2px 8px; border-radius:7px; cursor:pointer; }
#panel .flowbtn:hover { background:var(--hover-bg); }
#panel .issue { border-left:3px solid var(--danger); padding:6px 9px; margin:6px 0; background:var(--card); font-size:12px; border-radius:0 7px 7px 0; }
#panel .issue.warning { border-left-color:var(--warn); }
#panel .issue code { font-size:10.5px; color:var(--dim); }

/* Presentation mode = the canvas page, focused: the header chrome and legend
   are hidden, but the details panel stays TOGGLE-ABLE (the current settings are
   still applied). It does NOT force browser fullscreen (F11) — exiting is one
   step, not two. */
.cbody.presentation header, .cbody.presentation .legend { display:none; }
/* Embed mode (?_embed=true): the canvas is rendered inside the wairon web app's
   own chrome, so its redundant brand mark is hidden — the interactive toolbar
   (views, search, settings) stays. Keeps the iframe from showing a second logo. */
.cbody.embed header .brand { display:none; }
/* Embedded in the web UI: the app owns the brand + theme, so hide the canvas's
   own brand mark and Theme toggle (the host drives the canvas theme). */
.cbody.embed #themeBtn { display:none; }
/* The details panel hides by default in presentation, but the floating details
   toggle brings it back without leaving presentation mode. */
.cbody.presentation #panel, .cbody.presentation #panelResizer { display:none; }
.cbody.presentation.show-details #panel { display:block; }
.cbody.presentation.show-details #panelResizer { display:block; }
.cbody.presentation #wrap { height:100%; }
#exitPresent, #presentDetails { display:none; position:fixed; top:10px; z-index:100; border:1px solid var(--chrome-border); background:var(--chrome); color:var(--ink); border-radius:9px; padding:7px 13px; cursor:pointer; opacity:0.06; transition:opacity .15s ease; font:inherit; }
#exitPresent { right:10px; }
#presentDetails { right:190px; }
#exitPresent:hover, #presentDetails:hover { opacity:1; box-shadow:var(--syw-glow); }
.cbody.presentation #exitPresent, .cbody.presentation #presentDetails { display:block; }

@media (max-width: 860px) {
  #wrap { position:relative; }
  #panel { position:absolute; top:0; right:0; bottom:0; width:min(var(--panel-width, 360px), calc(100vw - 44px)); flex-basis:auto; box-shadow:var(--syw-deep-shadow); }
  #panelResizer { position:absolute; top:0; bottom:0; right:min(var(--panel-width, 360px), calc(100vw - 44px)); width:7px; flex-basis:auto; box-shadow:-3px 0 10px rgba(0,0,0,.18); }
  /* The panel overlays the stage here, so the floating header keeps full width. */
  .cbody:not(.panel-closed) header { right:12px; }
}

#flowModal { display:none; position:fixed; inset:0; background:rgba(4,6,12,0.6); backdrop-filter:blur(3px); z-index:80; align-items:center; justify-content:center; }
#flowModal.open { display:flex; }
#flowModal .box { width:min(880px, 92vw); height:min(660px, 88vh); background:var(--chrome); border:1px solid var(--chrome-border); border-radius:14px; box-shadow:var(--syw-deep-shadow); display:flex; flex-direction:column; overflow:hidden; }
#flowModal .bar { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); }
#flowModal .bar .crumbf { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#flowModal .bar .crumbf .dimc { color:var(--dim); font-weight:400; }
#flowCy { flex:1; }
#flowSteps { flex:1; display:none; overflow-y:auto; padding:16px 22px; }
#flowModal.steps #flowCy { display:none; }
#flowModal.steps #flowSteps { display:block; }
#flowSteps .fstep { border:1px solid var(--line); border-radius:9px; background:var(--card); padding:9px 12px; margin:8px 0; font-size:12.5px; }
#flowSteps .fstep .num { display:inline-block; min-width:22px; font-weight:700; color:var(--accent); }
#flowSteps .fstep .call { color:var(--dim); }
#flowSteps .fstep .call.drillstep { color:var(--accent); cursor:pointer; text-decoration:underline; }
#flowSteps .fstep .call.drillstep:hover { opacity:.82; }
#flowModal .hintbar { padding:6px 14px; color:var(--dim); font-size:11px; border-top:1px solid var(--line); }`;
