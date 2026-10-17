import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { WAIRON_VERSION } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// HTTP download
//
// Shared by the self-update check (fetch a release binary) and the pack store
// (fetch a .wpack from a selection's recorded source). Deliberately tiny and
// dependency-free — wairon ships as a standalone binary.
//
// Fetching only ever happens in EXPLICIT commands (`wairon update`,
// `wairon pack install <url>`, `wairon pack sync`). It is never reachable from
// validate/status/generate or an MCP tool call, because "works offline (core)"
// is a stated architectural invariant.
// ---------------------------------------------------------------------------

/** Download `url` to `dest`, following one level of redirect at a time. */
export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https://') ? https.get : http.get;

    // agent: false disables keep-alive so the socket closes as soon as the
    // response is done, preventing the event loop from hanging afterwards.
    get(url, { headers: { 'User-Agent': `wairon/${WAIRON_VERSION}` }, agent: false }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        res.destroy();
        downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        res.destroy();
        reject(new Error(`Download returned ${res.statusCode}`));
        return;
      }

      res.pipe(file);
      file.on('finish', () => {
        res.destroy();
        file.close(() => resolve());
      });
      file.on('error', (err) => {
        res.destroy();
        fs.unlink(dest, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}
