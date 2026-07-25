/* GENERATED — do not edit. */
export const CANVAS_SKELETON = `<header id="hdr">
  <span class="brand syw-gradient-text">wairon</span>
  <div class="seg" id="modeSeg" title="Switch between the component architecture, the type ERD, or the database schemas">
    <button data-vm="components" class="active">Components</button>
    <button data-vm="types">Types</button>
    <button data-vm="databases">Databases</button>
  </div>
  <div class="dropdown" id="modeDd" style="display:none">
    <button class="tbtn" id="modeBtn" title="Switch between the component architecture, the type ERD, or the database schemas">Components ▾</button>
    <div class="menu" id="modeMenu"></div>
  </div>
  <nav id="crumbs"></nav>
  <span class="divider"></span>
  <input id="search" type="search" placeholder="Search this view…">
  <div class="dropdown" id="searchDd" style="display:none">
    <button class="tbtn" id="searchBtn" title="Search this view">🔍</button>
    <div class="menu search-menu" id="searchMenu"></div>
  </div>
  <div class="seg" id="typesDetailSeg" style="display:none" title="ERD detail level">
    <button data-td="full">Full</button>
    <button data-td="fields">Fields</button>
    <button data-td="keys">Keys</button>
    <button data-td="names">Names</button>
  </div>
  <span class="spacer"></span>
  <div class="dropdown" id="settingsDd">
    <button class="tbtn" id="settingsBtn" title="View options">⚙ View ▾</button>
    <div class="menu settings-menu" id="settingsMenu">
      <label class="swrow">
        <span class="lbl">Internals<span class="sub">preview each box's children + relations</span></span>
        <span class="toggle"><input type="checkbox" id="internalsToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Externals<span class="sub">out-of-scope dependencies as ghosts</span></span>
        <span class="toggle"><input type="checkbox" id="externalsToggle" checked><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Data coupling<span class="sub">who uses another subsystem's types (dashed)</span></span>
        <span class="toggle"><input type="checkbox" id="dataCouplingToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Issues (<span id="issueCount"></span>)<span class="sub">overlay validation findings</span></span>
        <span class="toggle"><input type="checkbox" id="issuesToggle"><span class="track"></span></span>
      </label>
      <label class="swrow">
        <span class="lbl">Rearrange<span class="sub">drag boxes to fine-tune the layout</span></span>
        <span class="toggle"><input type="checkbox" id="dragToggle"><span class="track"></span></span>
      </label>
      <div class="swrow" style="flex-direction:column;align-items:flex-start;gap:6px;padding:8px 12px 10px;border-top:1px solid var(--line);">
        <span class="lbl" style="padding:0">Line Style<span class="sub" style="margin-top:2px">Choose how relationship lines are routed</span></span>
        <span class="selectWrap">
        <select id="lineStyleSelect" class="selectControl">
          <option value="bezier">Curved Bezier</option>
          <option value="straight">Straight Lines</option>
          <option value="taxi">Orthogonal Corners</option>
        </select>
        </span>
      </div>
    </div>
  </div>
  <button class="tbtn" id="fitBtn" title="Fit graph to view">Fit</button>
  <button class="tbtn" id="resetBtn" title="Discard this view's saved rearrangement">Reset layout</button>
  <button class="tbtn" id="panelToggle" title="Show or hide the details sidebar">Details</button>
  <div class="dropdown" id="layoutDd">
    <button class="tbtn" id="layoutBtn" title="Choose the auto-layout algorithm">Layout: Layered ▾</button>
    <div class="menu">
      <button id="layoutLayered">Layered <span class="hint">dependency columns (default)</span></button>
      <button id="layoutForce">Force <span class="hint">physics relaxation — untangles crossings</span></button>
      <button id="layoutConcentric">Concentric <span class="hint">most-referenced in the centre, rings outward</span></button>
      <button id="layoutGrid">Grid <span class="hint">compact wrapped rows</span></button>
    </div>
  </div>
  <div class="dropdown" id="exportDd">
    <button class="tbtn" id="exportBtn">Export ▾</button>
    <div class="menu">
      <button id="expPng">PNG image <span class="hint">this view, high-res</span></button>
      <button id="expDrawio">draw.io file <span class="hint">this view, editable, current layout</span></button>
      <button id="expExcalidraw">Excalidraw file <span class="hint">this view, editable, current layout</span></button>
    </div>
  </div>
  <button class="tbtn" id="themeBtn" title="Toggle theme">◐ Theme</button>
  <button class="tbtn" id="presentBtn" title="Presentation mode (hides menus)">⛶ Present</button>
  <div class="dropdown" id="moreDd" style="display:none">
    <button class="tbtn" id="moreBtn" title="More options">⋯</button>
    <div class="menu" id="moreMenu"></div>
  </div>
</header>
<div id="wrap">
  <div id="stage">
    <div id="cy"></div>
    <div class="viewhint" id="viewHint"></div>
    <div id="typesWarn"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div id="panelResizer" title="Drag to resize details sidebar"></div>
  <div id="panel"></div>
</div>
<button id="presentDetails">Details</button>
<button id="exitPresent">✕ Exit presentation</button>
<div id="flowModal">
  <div class="box">
    <div class="bar">
      <button class="tbtn" id="flowBack" title="Back to the calling narrative">← Back</button>
      <span class="crumbf" id="flowCrumb"></span>
      <span class="spacer"></span>
      <div class="seg" id="flowModeSeg">
        <button data-fm="flow" class="active">Flow</button>
        <button data-fm="steps">Steps</button>
      </div>
      <button class="tbtn" id="flowErrToggle" title="Hide the paths only reachable through error handling (catch regions, propagated throws)">Hide error paths</button>
      <div class="dropdown" id="flowExportDd">
        <button class="tbtn" id="flowExportBtn">Export ▾</button>
        <div class="menu">
          <button id="flowExpPng">PNG image</button>
          <button id="flowExpDrawio">draw.io file</button>
          <button id="flowExpExcalidraw">Excalidraw file</button>
        </div>
      </div>
      <button class="tbtn" id="flowClose">✕</button>
    </div>
    <div id="flowCy"></div>
    <div id="flowSteps"></div>`;
