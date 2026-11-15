// The build-time switch of the static demo. `__WAIRON_DEMO__` is replaced by the bundler: true
// only in the demo build (vite --mode demo), false in the normal web app, where every branch
// guarded by DEMO is removed from the bundle. Plain tests (no bundler) see it as absent.
declare const __WAIRON_DEMO__: boolean | undefined;

export const DEMO: boolean = typeof __WAIRON_DEMO__ !== 'undefined' && __WAIRON_DEMO__ === true;
