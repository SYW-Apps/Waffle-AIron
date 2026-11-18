// One spelling of a recorded request, shared by the recorder (scripts/demo) and the demo page, so
// the two always agree on the key a request is stored under.

/** JSON with every object's keys sorted, so equal arguments always give equal text. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** The key of one MCP tool call: the tool name and its canonical arguments. */
export function mcpKey(name, args) {
  return name + '|' + canonicalJson(args ?? {});
}

/** The key of one GET: its path, with the query parameters in sorted order. */
export function getKey(path) {
  const q = path.indexOf('?');
  if (q < 0) return path;
  const params = path
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '')
    .sort();
  return params.length === 0 ? path.slice(0, q) : path.slice(0, q) + '?' + params.join('&');
}
