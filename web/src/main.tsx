import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// SYW Design System 0.1.31, bundled from the installed package (no CDN at
// runtime): the aggregate (default theme + foundation + components + shells),
// the Waffler built-in theme as the pre-hydration palette, then the app's own
// product layout. The theme engine bridges its palette onto the --syw-* tokens.
import '@syw/design-system/syw.css';
import '@syw/design-system/themes/waffler.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
