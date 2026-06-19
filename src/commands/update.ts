import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION, GITHUB_REPO } from '../config/defaults.js';
import { getChannel, setChannel, UpdateChannel } from '../config/userconfig.js';

// ---------------------------------------------------------------------------
// update command
//
// Checks GitHub Releases for a newer version and optionally installs it.
//
// Channel support:
//   stable  — only stable releases (no -beta.N / -preview.N suffix)
//   beta    — stable + beta pre-releases
//   preview — stable + beta + preview pre-releases
//
// Usage:
//   wairon update                   — check and install if newer (uses saved channel)
//   wairon update --check           — check only, exit 0=up-to-date 1=update-available
//   wairon update --channel beta    — switch to beta channel and update
//   wairon update --channel stable  — switch back to stable channel
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  check?: boolean;
  channel?: UpdateChannel;
}

interface GithubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  prerelease: boolean;
  assets: GithubAsset[];
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  // Persist channel change if requested
  if (options.channel) {
    setChannel(options.channel);
    logger.success(`Update channel set to: ${options.channel}`);
  }

  const channel = options.channel ?? getChannel();
  logger.info(`Current version: ${WAIRON_VERSION}  (channel: ${channel})`);
  logger.info('Checking for updates...');

  let releases: GithubRelease[];
  try {
    releases = await fetchReleases(GITHUB_REPO);
  } catch (err) {
    logger.error(`Failed to check for updates: ${(err as Error).message}`);
    logger.info('Check your internet connection or visit the releases page manually.');
    process.exit(1);
  }

  // Filter releases by channel
  const eligible = releases.filter((r) => isEligibleForChannel(r.tag_name, channel));
  if (eligible.length === 0) {
    logger.success(`Already up to date (${WAIRON_VERSION})`);
    return;
  }

  const release = eligible[0]; // releases are sorted newest-first by GitHub
  const latestVersion = release.tag_name.replace(/^v/, '');
  const currentVersion = WAIRON_VERSION.replace(/^v/, '');

  if (!isNewer(currentVersion, latestVersion)) {
    logger.success(`Already up to date (${WAIRON_VERSION})`);
    return;
  }

  const channelLabel = release.prerelease ? ` [${releaseChannelLabel(release.tag_name)}]` : '';
  logger.info(`New version available: ${release.tag_name}${channelLabel}  (current: ${WAIRON_VERSION})`);

  if (release.body) {
    logger.blank();
    logger.info('Release notes:');
    const lines = release.body.split('\n').slice(0, 10);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    if (release.body.split('\n').length > 10) {
      console.log(`  ... (see full notes at ${release.html_url})`);
    }
    logger.blank();
  }

  if (options.check) {
    // Check-only: exit 1 to signal "update available"
    process.exit(1);
  }

  // Detect platform + arch to select the right asset
  const assetName = getPlatformAssetName(latestVersion);
  if (!assetName) {
    logger.warn('Automatic update is not supported for your platform.');
    logger.info(`Download manually from: ${release.html_url}`);
    process.exit(1);
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    logger.warn(`Asset "${assetName}" not found in release.`);
    logger.info(`Available assets: ${release.assets.map((a) => a.name).join(', ')}`);
    logger.info(`Download manually from: ${release.html_url}`);
    process.exit(1);
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, assetName);

  logger.info(`Downloading ${assetName}...`);
  try {
    await downloadFile(asset.browser_download_url, tmpFile);
  } catch (err) {
    logger.error(`Download failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const selfPath = getSelfPath();
  if (!selfPath) {
    logger.warn('Cannot self-update: wairon was installed via npm.');
    logger.info('Run `npm update -g waffle-airon` to update.');
    process.exit(1);
  }

  // Verify checksum before touching the installed binary
  const checksumAssetName = assetName + '.sha256';
  const checksumAsset = release.assets.find((a) => a.name === checksumAssetName);
  if (checksumAsset) {
    const tmpChecksum = path.join(tmpDir, checksumAssetName);
    logger.info(`Verifying checksum...`);
    try {
      await downloadFile(checksumAsset.browser_download_url, tmpChecksum);
      verifyChecksum(tmpFile, tmpChecksum, assetName);
      fs.unlinkSync(tmpChecksum);
    } catch (err) {
      logger.error(`Checksum verification failed: ${(err as Error).message}`);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      process.exit(1);
    }
  } else {
    logger.verbose(`No checksum file found for ${assetName} — skipping verification.`);
  }

  logger.info(`Installing to ${selfPath}...`);
  try {
    installBinary(tmpFile, selfPath);
  } catch (err) {
    logger.error(`Install failed: ${(err as Error).message}`);
    logger.info(`Downloaded binary is at: ${tmpFile}`);
    process.exit(1);
  }

  logger.blank();
  logger.success(`Updated to ${release.tag_name}`);
}

// ---------------------------------------------------------------------------
// Channel filtering
// ---------------------------------------------------------------------------

/**
 * Determine whether a release tag is eligible for the given channel.
 *   stable  → only tags without a pre-release suffix (v1.2.3)
 *   beta    → stable + tags with -beta.N suffix
 *   preview → stable + beta + tags with -preview.N suffix
 */
function isEligibleForChannel(tag: string, channel: UpdateChannel): boolean {
  const version = tag.replace(/^v/, '');
  const isBeta = /-beta\.\d+$/.test(version);
  const isPreview = /-preview\.\d+$/.test(version);
  const isStable = !isBeta && !isPreview;

  if (isStable) return true;
  if (isBeta && (channel === 'beta' || channel === 'preview')) return true;
  if (isPreview && channel === 'preview') return true;
  return false;
}

function releaseChannelLabel(tag: string): string {
  if (/-beta\.\d+$/.test(tag)) return 'beta';
  if (/-preview\.\d+$/.test(tag)) return 'preview';
  return 'stable';
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function fetchReleases(repo: string): Promise<GithubRelease[]> {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=20`;
    const options = {
      headers: {
        'User-Agent': `wairon/${WAIRON_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    };

    https.get(url, { ...options, agent: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        res.destroy();
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as GithubRelease[]);
        } catch {
          reject(new Error('Failed to parse GitHub API response'));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function downloadFile(url: string, dest: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Checksum verification
// ---------------------------------------------------------------------------

/**
 * Verify the SHA-256 checksum of a downloaded file.
 *
 * The .sha256 file format produced by sha256sum / Get-FileHash is:
 *   <hex-hash>  <filename>
 */
function verifyChecksum(filePath: string, checksumFile: string, expectedFilename: string): void {
  const checksumContent = fs.readFileSync(checksumFile, 'utf-8').trim();
  // Handle both "hash  filename" and bare "hash" formats
  const expectedHash = checksumContent.split(/\s+/)[0].toLowerCase();

  const fileBuffer = fs.readFileSync(filePath);
  const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').toLowerCase();

  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${expectedFilename}\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function getPlatformAssetName(version: string): string | null {
  const platform = process.platform;
  const arch = process.arch;

  const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' };
  const mappedArch = archMap[arch];
  if (!mappedArch) return null;

  if (platform === 'win32') return `wairon-${version}-windows-${mappedArch}.zip`;
  if (platform === 'darwin') return `wairon-${version}-macos-${mappedArch}.tar.gz`;
  if (platform === 'linux')  return `wairon-${version}-linux-${mappedArch}.tar.gz`;

  return null;
}

// ---------------------------------------------------------------------------
// Binary replacement
// ---------------------------------------------------------------------------

function getSelfPath(): string | null {
  if (isPkgBinary()) return process.execPath;
  return null;
}

function isPkgBinary(): boolean {
  return !!(process as NodeJS.Process & { pkg?: unknown }).pkg;
}

function installBinary(tmpFile: string, destPath: string): void {
  const platform = process.platform;
  const isZip = tmpFile.endsWith('.zip');
  const extractDir = path.join(os.tmpdir(), 'wairon-extract');

  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (isZip) {
    // Use ['ignore', 'pipe', 'pipe'] — piping stdin into PowerShell causes
    // "Input redirection is not supported" on Windows PowerShell 5.x.
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${tmpFile}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } else {
    execSync(`tar -xzf "${tmpFile}" -C "${extractDir}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const binaryName = platform === 'win32' ? 'wairon.exe' : 'wairon';
  const extractedBinary = path.join(extractDir, binaryName);

  if (!fs.existsSync(extractedBinary)) {
    throw new Error(`Extracted binary not found at ${extractedBinary}`);
  }

  if (platform === 'win32') {
    // On Windows you cannot overwrite a running exe, but you CAN rename it
    // (executables are opened with FILE_SHARE_DELETE). So we:
    //   1. Rename the running exe to .old  (instant, atomic on same volume)
    //   2. Copy the new binary into the now-free slot
    //   3. Attempt to delete .old immediately (succeeds when this process exits;
    //      if it fails here, cleanStaleBinary() removes it on next run)
    const oldPath = destPath + '.old';
    cleanStaleBinary(oldPath);
    fs.renameSync(destPath, oldPath);
    fs.copyFileSync(extractedBinary, destPath);
    try { fs.unlinkSync(oldPath); } catch { /* deleted on next startup */ }
  } else {
    const tmpDest = destPath + '.new';
    fs.copyFileSync(extractedBinary, tmpDest);
    fs.chmodSync(tmpDest, 0o755);
    fs.renameSync(tmpDest, destPath);
  }

  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  try { fs.rmSync(extractDir, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Remove a leftover .old binary from a previous update attempt.
 * Called at startup (cli/index.ts) and before each rename.
 */
export function cleanStaleBinary(oldPath?: string): void {
  const target = oldPath ?? (isPkgBinary() ? process.execPath + '.old' : null);
  if (!target) return;
  if (fs.existsSync(target)) {
    try { fs.unlinkSync(target); } catch { /* still locked — ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Version comparison (semver-lite, handles X.Y.Z and X.Y.Z-suffix.N)
// ---------------------------------------------------------------------------

export function isNewer(current: string, candidate: string): boolean {
  // Strip pre-release suffix for base version comparison
  const baseVersion = (v: string) => v.replace(/-.*$/, '');
  const preRelease = (v: string) => {
    const match = v.match(/-(.+)\.(\d+)$/);
    return match ? { label: match[1], n: parseInt(match[2], 10) } : null;
  };

  const parse = (v: string) => baseVersion(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [nMaj, nMin, nPat] = parse(candidate);

  if (nMaj !== cMaj) return nMaj > cMaj;
  if (nMin !== cMin) return nMin > cMin;
  if (nPat !== cPat) return nPat > cPat;

  // Same base version: stable > pre-release; higher pre-release N wins
  const cPre = preRelease(current);
  const nPre = preRelease(candidate);

  if (!cPre && !nPre) return false;    // same stable
  if (!cPre && nPre) return false;     // current stable, candidate is pre-release — not newer
  if (cPre && !nPre) return true;      // current pre-release, candidate stable — stable wins
  if (cPre && nPre) return nPre.n > cPre.n; // both pre-release, higher N wins

  return false;
}
