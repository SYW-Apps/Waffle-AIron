import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';
import { WAFFAGENT_VERSION, GITHUB_REPO } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// update command
//
// Checks GitHub Releases for a newer version and optionally installs it.
//
// Usage:
//   waffagent update          — check and install if newer
//   waffagent update --check  — check only, print result, exit 0/1
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  check?: boolean; // check-only, no install
}

interface GithubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: GithubAsset[];
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  logger.info(`Current version: ${WAFFAGENT_VERSION}`);
  logger.info('Checking for updates...');

  let release: GithubRelease;
  try {
    release = await fetchLatestRelease(GITHUB_REPO);
  } catch (err) {
    logger.error(`Failed to check for updates: ${(err as Error).message}`);
    logger.info('Check your internet connection or visit the releases page manually.');
    process.exit(1);
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  const currentVersion = WAFFAGENT_VERSION.replace(/^v/, '');

  if (!isNewer(currentVersion, latestVersion)) {
    logger.success(`Already up to date (${WAFFAGENT_VERSION})`);
    return;
  }

  logger.info(`New version available: ${release.tag_name}  (current: ${WAFFAGENT_VERSION})`);
  if (release.body) {
    logger.blank();
    logger.info('Release notes:');
    // Print first 10 lines of release notes
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
    // Check-only: exit 1 to signal "update available" (mirrors common CLI conventions)
    process.exit(1);
  }

  // Detect platform + arch to select the right asset
  const assetName = getPlatformAssetName(release.tag_name);
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

  // Download to a temp file
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, assetName);

  logger.info(`Downloading ${assetName}...`);
  try {
    await downloadFile(asset.browser_download_url, tmpFile);
  } catch (err) {
    logger.error(`Download failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Replace the current binary
  const selfPath = getSelfPath();
  if (!selfPath) {
    logger.warn('Could not determine the path of the current binary.');
    logger.info(`Update downloaded to: ${tmpFile}`);
    logger.info('Replace the binary manually.');
    process.exit(1);
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
// GitHub API
// ---------------------------------------------------------------------------

function fetchLatestRelease(repo: string): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const options = {
      headers: {
        'User-Agent': `waffagent/${WAFFAGENT_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        https.get(res.headers.location!, options, handleResponse(resolve, reject));
        return;
      }
      handleResponse(resolve, reject)(res);
    }).on('error', reject);
  });
}

function handleResponse(
  resolve: (v: GithubRelease) => void,
  reject: (e: Error) => void,
): (res: http.IncomingMessage) => void {
  return (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode}: ${data.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(data) as GithubRelease);
      } catch {
        reject(new Error('Failed to parse GitHub API response'));
      }
    });
    res.on('error', reject);
  };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https://') ? https.get : http.get;

    get(url, { headers: { 'User-Agent': `waffagent/${WAFFAGENT_VERSION}` } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect (GitHub assets redirect to CDN)
        file.close();
        downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download returned ${res.statusCode}`));
        return;
      }

      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => {
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
// Platform detection
// ---------------------------------------------------------------------------

function getPlatformAssetName(tag: string): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const version = tag.replace(/^v/, '');

  const archMap: Record<string, string> = {
    x64: 'x64',
    arm64: 'arm64',
  };

  const mappedArch = archMap[arch];
  if (!mappedArch) return null;

  if (platform === 'win32') {
    return `waffagent-${version}-windows-${mappedArch}.zip`;
  }
  if (platform === 'darwin') {
    return `waffagent-${version}-macos-${mappedArch}.tar.gz`;
  }
  if (platform === 'linux') {
    return `waffagent-${version}-linux-${mappedArch}.tar.gz`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Binary replacement
// ---------------------------------------------------------------------------

function getSelfPath(): string | null {
  // For pkg-compiled binaries, process.execPath is the binary itself.
  // For Node.js scripts, we want the script path.
  const execPath = process.execPath;

  // If running as a pkg binary, execPath IS the binary
  if (isPkgBinary()) {
    return execPath;
  }

  // Running as a Node.js script — not self-updatable in this mode
  return null;
}

function isPkgBinary(): boolean {
  // pkg sets process.pkg when bundled
  return !!(process as NodeJS.Process & { pkg?: unknown }).pkg;
}

function installBinary(tmpFile: string, destPath: string): void {
  const platform = process.platform;
  const isZip = tmpFile.endsWith('.zip');
  const tmpExtracted = tmpFile.replace(/\.(zip|tar\.gz)$/, '');

  if (isZip) {
    // Windows: use PowerShell to extract
    execSync(
      `powershell -Command "Expand-Archive -Path '${tmpFile}' -DestinationPath '${path.dirname(tmpExtracted)}' -Force"`,
      { stdio: 'pipe' },
    );
  } else {
    // Unix: use tar
    execSync(`tar -xzf "${tmpFile}" -C "${path.dirname(tmpExtracted)}"`, { stdio: 'pipe' });
  }

  // Find the extracted binary
  const binaryName = platform === 'win32' ? 'waffagent.exe' : 'waffagent';
  const extractedBinary = path.join(path.dirname(tmpExtracted), binaryName);

  if (!fs.existsSync(extractedBinary)) {
    throw new Error(`Extracted binary not found at ${extractedBinary}`);
  }

  // On Unix: write to a tmp file next to the target, then rename (atomic on same fs)
  // On Windows: write to a .new file and schedule rename via cmd
  if (platform === 'win32') {
    const newPath = destPath + '.new';
    fs.copyFileSync(extractedBinary, newPath);
    // Schedule rename: waffagent.exe.new → waffagent.exe after process exits
    // We use a batch script trick since you can't replace a running exe on Windows
    const batchScript = path.join(os.tmpdir(), 'waffagent_update.bat');
    fs.writeFileSync(
      batchScript,
      `@echo off\r\n` +
      `timeout /t 2 /nobreak >nul\r\n` +
      `move /y "${newPath}" "${destPath}"\r\n` +
      `del "%~f0"\r\n`,
    );
    execSync(`cmd /c start /b "" cmd /c "${batchScript}"`);
    logger.info('Binary will be replaced after waffagent exits (Windows in-place update).');
  } else {
    const tmpDest = destPath + '.new';
    fs.copyFileSync(extractedBinary, tmpDest);
    fs.chmodSync(tmpDest, 0o755);
    fs.renameSync(tmpDest, destPath); // atomic on same filesystem
  }

  // Cleanup
  try {
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(extractedBinary);
  } catch { /* ignore cleanup errors */ }
}

// ---------------------------------------------------------------------------
// Version comparison (semver-lite: only handles X.Y.Z)
// ---------------------------------------------------------------------------

export function isNewer(current: string, candidate: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [nMaj, nMin, nPat] = parse(candidate);

  if (nMaj !== cMaj) return nMaj > cMaj;
  if (nMin !== cMin) return nMin > cMin;
  return nPat > cPat;
}
