import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// install.sh verify_checksum, run against a fake archive (no network). Skipped
// where no POSIX sh is available.
const installSh = path.resolve(__dirname, '../../install.sh').split(path.sep).join('/');
const hasSh = spawnSync('sh', ['-c', 'command -v sha256sum || command -v shasum'], { encoding: 'utf8' }).status === 0;

function verify(archive: string, shaFile: string) {
  return spawnSync('sh', ['-c', `WAIRON_INSTALL_SOURCE_ONLY=1; . "${installSh}"; verify_checksum "$1" "$2"`, 'sh', archive, shaFile], { encoding: 'utf8' });
}

describe.skipIf(!hasSh)('install.sh verify_checksum', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-inst-'));
  const archive = path.join(dir, 'a.tar.gz').split(path.sep).join('/');
  fs.writeFileSync(archive, 'fake archive bytes');
  const hex = crypto.createHash('sha256').update('fake archive bytes').digest('hex');
  const sha = path.join(dir, 'a.tar.gz.sha256').split(path.sep).join('/');

  it('accepts a matching checksum (uppercase tolerated)', () => {
    fs.writeFileSync(sha, `${hex.toUpperCase()}  a.tar.gz\n`);
    expect(verify(archive, sha).status).toBe(0);
  });
  it('refuses a mismatch', () => {
    fs.writeFileSync(sha, `${'0'.repeat(64)}  a.tar.gz\n`);
    const r = verify(archive, sha);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Checksum mismatch');
  });
  it('refuses an empty checksum file', () => {
    fs.writeFileSync(sha, '');
    expect(verify(archive, sha).status).not.toBe(0);
  });
});
