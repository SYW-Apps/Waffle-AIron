// ---------------------------------------------------------------------------
// io — wairon's generic outside-action layer
//
// One place to change or migrate the library behind a file, a process or an
// outbound HTTP call, and one call per action for anything that needs one:
//
//   import { files } from '../io/index.js';
//   files.readText(path);
//
// The three shared Adapters of subsystem sdd_io (files_adapter, process_adapter,
// http_client_adapter): any component may depend on one directly and call it.
// ---------------------------------------------------------------------------

export * as files from './files.js';
export * as processes from './process.js';
export * as http from './http.js';
