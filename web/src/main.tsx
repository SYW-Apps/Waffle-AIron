import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DEMO } from './demo/flag';
// SYW Design System 0.1.31, bundled from the installed package (no CDN at
// runtime): the aggregate (default theme + foundation + components + shells),
// the Waffler built-in theme as the pre-hydration palette, then the app's own
// product layout. The theme engine bridges its palette onto the --syw-* tokens.
import '@syw/design-system/syw.css';
import '@syw/design-system/themes/waffler.css';
import './theme.css';

const root = createRoot(document.getElementById('root')!);

if (DEMO) {
  // The static demo (a separate build): the page of ./demo, never the server-backed app. A page
  // that is framed stays blank until the framing page sends its appearance.
  if (window.parent !== window) document.documentElement.style.visibility = 'hidden';
  void import('./demo/DemoApp').then(({ DemoApp }) =>
    root.render(
      <StrictMode>
        <DemoApp />
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
