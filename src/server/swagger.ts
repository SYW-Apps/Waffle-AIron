import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Self-contained Swagger UI viewer (sdd_host). The swagger-ui-dist browser
// assets (~1.5 MB) are read from node_modules on first use and cached; the page
// INLINES them so it has no external dependency (works under the share page's
// CSP and offline). Falls back to a minimal pretty-printed page when the assets
// are unavailable (kept external from the bundle — see tsup.config.ts).
// ---------------------------------------------------------------------------

let cache: { css: string; js: string } | null | undefined; // undefined = unloaded, null = unavailable

function loadAssets(): { css: string; js: string } | null {
  if (cache !== undefined) return cache;
  try {
    const dir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
    cache = {
      css: fs.readFileSync(path.join(dir, 'swagger-ui.css'), 'utf8'),
      js: fs.readFileSync(path.join(dir, 'swagger-ui-bundle.js'), 'utf8'),
    };
  } catch {
    cache = null;
  }
  return cache;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** True when the interactive Swagger UI can be rendered (assets resolvable). */
export function swaggerUiAvailable(): boolean {
  return loadAssets() !== null;
}

/**
 * A self-contained HTML page rendering the given OpenAPI JSON with an interactive
 * Swagger UI, or a minimal pretty-printed page when the assets can't be loaded.
 */
export function swaggerUiPage(specJson: string, title = 'API'): string {
  const assets = loadAssets();
  if (!assets) return prettyPage(specJson, title);
  // A literal `</script>` inside the spec would terminate the inline init script.
  const safeSpec = specJson.replace(/<\/(script)/gi, '<\\/$1');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${esc(title)} — Swagger UI</title>` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${assets.css}</style></head><body>` +
    '<div id="swagger-ui"></div>' +
    `<script>${assets.js}</script>` +
    '<script>window.ui=SwaggerUIBundle({spec:' +
    safeSpec +
    ",dom_id:'#swagger-ui',deepLinking:true,tryItOutEnabled:true,presets:[SwaggerUIBundle.presets.apis],layout:'BaseLayout'});</script>" +
    '</body></html>'
  );
}

function prettyPage(specJson: string, title: string): string {
  let pretty = specJson;
  try {
    pretty = JSON.stringify(JSON.parse(specJson), null, 2);
  } catch {
    /* keep raw */
  }
  return (
    '<!doctype html><meta charset="utf-8">' +
    `<title>${esc(title)} — OpenAPI</title>` +
    '<body style="font:13px/1.5 ui-monospace,monospace;margin:0;background:#0b1120;color:#e8e8f0">' +
    '<pre style="padding:20px;white-space:pre-wrap;word-break:break-word">' +
    esc(pretty) +
    '</pre></body>'
  );
}
