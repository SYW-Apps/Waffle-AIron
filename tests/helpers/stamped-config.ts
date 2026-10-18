import * as yaml from 'js-yaml';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// A hand-written project.yaml for a test fixture, stamped with the running
// major. The stamp is a top-level `waironMajor:` line, which the upgrade
// module reads as text, so a fixture written as one JSON line carries none and
// reads as a tree an older major wrote. Every fixture a real CLI run reads
// through this, or `wairon <command>` refuses it and names `wairon upgrade`.
// ---------------------------------------------------------------------------

/** The YAML text of a project configuration, stamped with the running major. */
export function stampedProjectYaml(config: Record<string, unknown>): string {
  return yaml.dump({ waironMajor: WAIRON_MAJOR, ...config }, { noRefs: true, lineWidth: 200 });
}
