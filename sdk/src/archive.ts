import * as fs from 'fs';
import * as path from 'path';
import { zipSync, unzipSync, type Zippable } from 'fflate';
import type { ArchiveEntryMeta, PackFile } from './types.js';

// ---------------------------------------------------------------------------
// Pack Archive Adapter (pack_archive_adapter_impl) — the ONLY zip-library + fs
// I/O boundary of the SDK. Technology: fflate (pure-JS ZIP, no native deps).
//
// Acts only on already-validated inputs: it makes no path-safety or format
// decisions (that is the codec's job). Enumeration reads sizes WITHOUT
// inflating so the codec can enforce zip-bomb / size caps before any bytes are
// decompressed.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

/**
 * Enumerate every entry's metadata (path, compressed + uncompressed size, kind)
 * WITHOUT decompressing any bytes, so the codec can enforce caps before
 * inflation.
 */
export function listEntries(archive: Uint8Array): ArchiveEntryMeta[] {
  // Step 1: read the central directory via the zip library, mapping each record
  // to ArchiveEntryMeta without inflating any data. fflate's filter reports
  // {name, size (compressed), originalSize (uncompressed)} for every entry;
  // returning false skips decompression. Symlink detection reads the central
  // directory's external attributes (fflate's metadata omits the unix mode).
  const symlinks = detectSymlinkNames(archive);
  const metas: ArchiveEntryMeta[] = [];
  unzipSync(archive, {
    filter: (info): boolean => {
      metas.push({
        path: info.name,
        uncompressedSize: info.originalSize,
        compressedSize: info.size,
        kind: classifyKind(info.name, symlinks),
      });
      return false;
    },
  });
  // Step 2: return the entry metadata list.
  return metas;
}

/** Decompress and return the bytes of a single named entry. */
export function inflateEntry(archive: Uint8Array, entryPath: string): Uint8Array {
  // Step 1: locate the named entry and inflate only it.
  const inflated = unzipSync(archive, { filter: (info): boolean => info.name === entryPath });
  const bytes = inflated[entryPath];
  if (!bytes) throw new Error(`archive entry not found: ${entryPath}`);
  // Step 2: return the entry's decompressed bytes.
  return bytes;
}

/** Deflate a set of files (the envelope + pack contents) into a single ZIP buffer. */
export function assembleArchive(files: PackFile[]): Uint8Array {
  // Step 1: add each file to a zip container (deflating) and finalize.
  const zippable: Zippable = {};
  for (const file of files) zippable[file.path] = file.contents;
  const bytes = zipSync(zippable);
  // Step 2: return the archive bytes.
  return bytes;
}

/** Read a source pack directory recursively into a file map (POSIX paths + bytes). */
export function readPackDir(dir: string): PackFile[] {
  // Step 1: walk the directory recursively, reading each file into
  // { path: POSIX-relative, contents } (skipping node_modules and VCS dirs).
  const files: PackFile[] = [];
  walkPackDir(dir, dir, files);
  // Step 2: return the file map.
  return files;
}

/** Write a file map as a directory tree under destDir, creating parent directories. */
export function writeTree(destDir: string, files: PackFile[]): void {
  // Step 1: write each approved file.
  for (const file of files) {
    // Step 2 (writeEnd): create parent directories and write the file's bytes.
    const absolute = path.join(destDir, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents);
  }
  // Step 3: done.
}

// --- helpers ---------------------------------------------------------------

function classifyKind(name: string, symlinks: Set<string>): string {
  if (symlinks.has(name)) return 'symlink';
  if (name.endsWith('/')) return 'dir';
  return 'file';
}

function walkPackDir(root: string, current: string, out: PackFile[]): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkPackDir(root, path.join(current, entry.name), out);
    } else if (entry.isFile()) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      out.push({ path: relative, contents: fs.readFileSync(absolute) });
    }
  }
}

// Best-effort central-directory scan for symlink entries (unix S_IFLNK in the
// external file attributes). fflate's high-level metadata omits the unix mode,
// so the codec's symlink rejection needs this. Any parse trouble yields an
// empty set — no worse than fflate alone, and confinement/size caps still apply.
function detectSymlinkNames(archive: Uint8Array): Set<string> {
  const names = new Set<string>();
  try {
    const eocd = findEocd(archive);
    if (eocd < 0) return names;
    let p = readU32(archive, eocd + 16); // central directory offset
    const count = readU16(archive, eocd + 10);
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (readU32(archive, p) !== 0x02014b50) break; // central file header sig
      const versionMadeBy = readU16(archive, p + 4);
      const nameLen = readU16(archive, p + 28);
      const extraLen = readU16(archive, p + 30);
      const commentLen = readU16(archive, p + 32);
      const externalAttrs = readU32(archive, p + 38);
      const name = decoder.decode(archive.subarray(p + 46, p + 46 + nameLen));
      if ((versionMadeBy >> 8) === 3) { // unix host
        const unixMode = (externalAttrs >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) names.add(name);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch {
    return names;
  }
  return names;
}

function findEocd(buf: Uint8Array): number {
  const minRecord = 22;
  const lowerBound = Math.max(0, buf.length - (minRecord + 0xffff));
  for (let i = buf.length - minRecord; i >= lowerBound; i--) {
    if (readU32(buf, i) === 0x06054b50) return i;
  }
  return -1;
}

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
