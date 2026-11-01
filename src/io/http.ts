import * as http from 'http';
import * as https from 'https';
import { WAIRON_VERSION } from '../config/defaults.js';
import * as files from './files.js';

// ---------------------------------------------------------------------------
// io/http — outbound HTTP, one call per outside action
//
// wairon's one place to call another server. `request` is fetch (the Response
// comes back as it is), `getText` is a plain GET that answers the status and
// body, `download` saves a URL to a file. Inbound servers (the portals, the
// realtime socket) are not here: they are transport for Portals, not outside
// actions of wairon's own.
//
// Outside calls only ever happen in explicit commands and hosted-plane
// operations; none is reachable from validate, status or generate.
// ---------------------------------------------------------------------------

/** What a fetch-style request takes: the platform's RequestInit. */
export type HttpRequestInit = RequestInit;

/** What a fetch-style request answers: the platform's Response. */
export type HttpFetchResponse = Response;

/** An outbound request with fetch semantics: the Response, whatever its status. Rejects when the server cannot be reached. */
export function request(url: string, init?: HttpRequestInit): Promise<HttpFetchResponse> {
  return fetch(url, init);
}

/** What a plain GET answers: the status code and the body as text. */
export interface TextResponse {
  status: number | undefined;
  body: string;
}

/** GET a URL (http or https by its scheme), no redirects followed, and answer its status and body. Rejects when the server cannot be reached. */
export function getText(url: string, headers: Record<string, string>): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https://') ? https.get : http.get;
    // agent: false disables keep-alive so the socket closes as soon as the
    // response is done, preventing the event loop from hanging afterwards.
    get(url, { headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        res.destroy();
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Download `url` to `dest`, following one level of redirect at a time. */
export function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = files.openWriteStream(dest);
    const get = url.startsWith('https://') ? https.get : http.get;

    // agent: false disables keep-alive so the socket closes as soon as the
    // response is done, preventing the event loop from hanging afterwards.
    get(url, { headers: { 'User-Agent': `wairon/${WAIRON_VERSION}` }, agent: false }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        res.destroy();
        download(res.headers.location!, dest).then(resolve).catch(reject);
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
        files.removeFileLater(dest);
        reject(err);
      });
    }).on('error', (err) => {
      files.removeFileLater(dest);
      reject(err);
    });
  });
}
