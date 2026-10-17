import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION, GITHUB_REPO } from '../config/defaults.js';
import {
  getChannel,
  setChannel,
  isUpdateChannel,
  UPDATE_CHANNELS,
  UpdateChannel,
} from '../config/userconfig.js';
import { isNewerVersion } from '../utils/version.js';
import { downloadFile } from '../utils/download.js';

// ---------------------------------------------------------------------------
// update command
//
// Checks GitHub Releases for a newer version and optionally installs it.
//
// Channel support — each channel sees its own tier and every narrower one:
//   stable  — only stable releases (vX.Y.Z, no pre-release suffix)
//   beta    — stable + -beta.N
//   preview — stable + -beta.N + -preview.N
//   dev     — everything, including the -dev.N build cut from every dev merge
//
// Usage:
//   wairon update                   — check and install if newer (uses saved channel)
//   wairon update --check           — check only, exit 0=up-to-date 1=update-available
//   wairon update --channel beta    — switch to beta channel and update
//   wairon update --channel stable  — switch back to stable channel
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  check?: boolean;
  /** Raw `--channel` value — validated here, since commander accepts any string. */
  channel?: string;
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
  let requested: UpdateChannel | undefined;
  if (options.channel) {
    if (!isUpdateChannel(options.channel)) {
      logger.error(
        `Unknown update channel "${options.channel}". Valid channels: ${UPDATE_CHANNELS.join(', ')}`,
      );
      process.exit(1);
      return;
    }
    requested = options.channel;
    setChannel(requested);
    logger.success(`Update channel set to: ${requested}`);
  }

  const channel = requested ?? getChannel();
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

  const currentVersion = WAIRON_VERSION.replace(/^v/, '');

  // Filter releases by channel
  const eligible = releases.filter((r) => isEligibleForChannel(r.tag_name, channel, r.prerelease));
  const release = eligible[0]; // releases are sorted newest-first by GitHub

  reportOffChannelBuild(channel, currentVersion, release?.tag_name);

  if (!release || !isNewer(currentVersion, release.tag_name.replace(/^v/, ''))) {
    logger.success(`Already up to date (${WAIRON_VERSION}, channel: ${channel})`);
    reportWiderChannel(releases, channel, currentVersion);
    return;
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  const label = releaseChannelLabel(release.tag_name);
  const channelLabel = label === 'stable' ? '' : ` [${label}]`;
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
    // npm's own channel is the dist-tag, which mirrors these channels 1:1
    // (stable publishes to `latest`, the rest to a tag of the same name).
    const distTag = channel === 'stable' ? 'latest' : channel;
    logger.info(`Run \`npm install -g @wairon/cli@${distTag}\` to update.`);
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
 * Channel breadth, narrowest first. A channel is eligible for every release
 * whose tier is at or below its own rank, so `dev` sees everything and
 * `stable` sees only untagged releases.
 */
const CHANNEL_RANK: Record<UpdateChannel, number> = {
  stable: 0,
  beta: 1,
  preview: 2,
  dev: 3,
};

/**
 * Classify a release into a channel tier.
 *
 * Closed by default: anything carrying a pre-release suffix is a pre-release,
 * and a suffix this build does not recognize ranks at the widest tier rather
 * than falling through to `stable`. That fall-through is exactly what let
 * `-dev.N` builds reach stable installs — `-dev` was simply not in the list of
 * known pre-release labels, so it read as a stable release.
 */
export function releaseTier(tag: string, githubPrerelease = false): number {
  const version = tag.replace(/^v/, '');
  const dash = version.indexOf('-');

  if (dash === -1) {
    // No suffix. Cross-check GitHub's own flag: a release the publisher marked
    // pre-release is never a stable-channel candidate, whatever the tag says.
    return githubPrerelease ? CHANNEL_RANK.dev : CHANNEL_RANK.stable;
  }

  const label = version.slice(dash + 1).replace(/\.\d+$/, '');
  const rank = CHANNEL_RANK[label as UpdateChannel];
  return rank === undefined || rank === CHANNEL_RANK.stable ? CHANNEL_RANK.dev : rank;
}

/**
 * Say so when the running build is wider than the configured channel — e.g. a
 * `stable` install running a `-dev.N` build, which is what the old filter
 * produced. Such a build is not "newer" than the stable line it forked from, so
 * the version check alone reports "up to date" and the mismatch stays invisible
 * until the next stable release catches up.
 */
function reportOffChannelBuild(
  channel: UpdateChannel,
  currentVersion: string,
  newestOnChannel: string | undefined,
): void {
  const tier = releaseTier(currentVersion);
  if (tier <= (CHANNEL_RANK[channel] ?? CHANNEL_RANK.stable)) return;

  const label = releaseChannelLabel(currentVersion);
  logger.warn(
    `This is a ${label} build (${WAIRON_VERSION}) but the update channel is ${channel}.`,
  );
  const target = newestOnChannel ? ` The newest ${channel} release is ${newestOnChannel}.` : '';
  const track = isUpdateChannel(label)
    ? `Track this build with \`wairon update --channel ${label}\`, or reinstall`
    : 'Reinstall';
  logger.info(`It will not update until ${channel} passes it.${target} ${track} to return to ${channel}.`);
  logger.blank();
}

/**
 * When an up-to-date narrower channel is sitting behind a newer pre-release,
 * say so once. Without this the only signal is silence, which reads as "there
 * is nothing newer" rather than "there is nothing newer *on your channel*".
 */
function reportWiderChannel(
  releases: GithubRelease[],
  channel: UpdateChannel,
  currentVersion: string,
): void {
  const wider = releases.find(
    (r) =>
      !isEligibleForChannel(r.tag_name, channel, r.prerelease) &&
      isNewer(currentVersion, r.tag_name.replace(/^v/, '')),
  );
  if (!wider) return;

  const label = releaseChannelLabel(wider.tag_name);
  const hint = isUpdateChannel(label)
    ? ` — install it with \`wairon update --channel ${label}\`.`
    : '.';
  logger.info(`A newer pre-release exists: ${wider.tag_name} [${label}]${hint}`);
}

/** Determine whether a release is eligible for the given channel. */
export function isEligibleForChannel(
  tag: string,
  channel: UpdateChannel,
  githubPrerelease = false,
): boolean {
  return releaseTier(tag, githubPrerelease) <= (CHANNEL_RANK[channel] ?? CHANNEL_RANK.stable);
}

/** The channel label to show for a release — the raw suffix when unrecognized. */
export function releaseChannelLabel(tag: string): string {
  const version = tag.replace(/^v/, '');
  const dash = version.indexOf('-');
  if (dash === -1) return 'stable';
  return version.slice(dash + 1).replace(/\.\d+$/, '') || 'stable';
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function fetchReleases(repo: string): Promise<GithubRelease[]> {
  return new Promise((resolve, reject) => {
    // 100 (the GitHub maximum) rather than a page that a run of pre-releases
    // can fill: `dev` cuts a build per merge, so a page of 20 can hold nothing
    // but -dev.N and leave a stable install seeing no eligible release at all.
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
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
// Download — lifted to utils/download.ts so the pack store fetches a .wpack
// with the same redirect-following implementation this uses for a release.
// ---------------------------------------------------------------------------

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
    try {
      cleanStaleBinary(oldPath);
      fs.renameSync(destPath, oldPath);
      fs.copyFileSync(extractedBinary, destPath);
      try { fs.unlinkSync(oldPath); } catch { /* deleted on next startup */ }
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EBUSY') {
        throw new Error(
          `wairon.exe is currently in use by an active session (e.g. background MCP servers or IDE agents).\n` +
          `  Please close all running wairon processes (or run 'taskkill /F /IM wairon.exe' in PowerShell) and try again.`
        );
      }
      throw err;
    }
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
// Version comparison — lifted to utils/version.ts so the pack store shares one
// comparator with the update check instead of a second copy that drifts.
// Aliased (not re-exported) so this module's own call site still binds locally.
// ---------------------------------------------------------------------------

export const isNewer = isNewerVersion;
