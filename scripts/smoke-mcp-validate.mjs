#!/usr/bin/env node
// Release smoke: start a built wairon binary's MCP server on a project and call
// sdd_validate_tree once. The serving process runs the gate on a worker thread
// whose entry is a file of its own, so a binary that runs `validate --ci` fine
// can still fail every validation it serves. Exits non-zero when the call
// answers an error or never answers.
//
//   node scripts/smoke-mcp-validate.mjs <binary> [<project root>]
import { spawn } from 'node:child_process';

const [binary, root = process.cwd()] = process.argv.slice(2);
if (!binary) {
  console.error('usage: smoke-mcp-validate.mjs <binary> [<project root>]');
  process.exit(2);
}

const child = spawn(binary, ['mcp', 'serve'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const finish = (code, text) => {
  console.log(text);
  child.kill();
  process.exit(code);
};

let buffered = '';
child.stdout.on('data', (chunk) => {
  buffered += chunk.toString();
  let end;
  while ((end = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, end).trim();
    buffered = buffered.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sdd_validate_tree', arguments: { recursive: false } } });
    } else if (message.id === 2) {
      const text = message.result?.content?.[0]?.text ?? JSON.stringify(message);
      if (message.error || message.result?.isError) finish(1, `sdd_validate_tree through the MCP server failed: ${text.slice(0, 500)}`);
      else finish(0, 'sdd_validate_tree through the MCP server answered');
    }
  }
});
child.on('exit', (code) => finish(1, `the MCP server exited (code ${code}) before answering`));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } });
setTimeout(() => finish(1, 'sdd_validate_tree through the MCP server did not answer within 180 s'), 180000);
