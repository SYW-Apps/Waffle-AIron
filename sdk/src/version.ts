// The running @wairon/sdk version — stamped into built archives (generatedBy)
// and used as the "running wairon version" for pack version-compatibility
// checks. tsup inlines package.json at build time; at runtime the require
// resolves against the shipped package (../package.json from dist/).

export const SDK_VERSION: string = loadVersion();

function loadVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
