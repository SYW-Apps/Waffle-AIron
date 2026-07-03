# Vendored canvas assets

cytoscape.min.js — Cytoscape.js (MIT, The Cytoscape Consortium), currently v3.34.x.
Embedded inline into every generated canvas.html so the artifact stays fully
self-contained and offline (wairon invariant: no network requirement).

To update: bump the cytoscape devDependency, then copy
node_modules/cytoscape/dist/cytoscape.min.js over this file and regenerate
a canvas to smoke-test.
