import * as fs from 'fs';

// ---------------------------------------------------------------------------
// io/files — the filesystem, one call per outside action
//
// wairon's one place for filesystem access. Every function is a verb on a
// path and behaves exactly as the `fs` call it wraps (same errors, same
// encodings), so a call site that moves here changes nothing about what it
// does. The point is the seam: a library or runtime that changes how files
// are read or written is changed here once, and a caller that needs an
// outside action makes one call.
//
// This is not the spec-tree write guard. A write made here is a raw write;
// the guarded writes of a project's .wai tree stay in utils/fs.ts.
// ---------------------------------------------------------------------------

/** A directory entry: its name and what kind of thing it is. */
export type DirEntry = fs.Dirent;

/** What a path is: file/directory/link, its size, change time and mode. */
export type FileStat = fs.Stats;

// -- Reading ----------------------------------------------------------------

/** Whether a path exists (a file, a folder, or anything else). */
export function exists(path: string): boolean {
  return fs.existsSync(path);
}

/** A file's content as UTF-8 text. Throws as readFileSync does. */
export function readText(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

/** A file's content as bytes, unchanged. Throws as readFileSync does (an absent file, a folder). */
export function readBytes(path: string): Buffer {
  return fs.readFileSync(path);
}

/** The names in a folder (not recursive), in the order the filesystem gives them. */
export function list(dir: string): string[] {
  return fs.readdirSync(dir);
}

/** The entries in a folder with their kinds (isFile, isDirectory, isSymbolicLink). */
export function listEntries(dir: string): DirEntry[] {
  return fs.readdirSync(dir, { withFileTypes: true });
}

/** What a path is, following links. Throws when it is absent. */
export function stat(path: string): FileStat {
  return fs.statSync(path);
}

/** What a path is, following links; undefined when it is absent (other errors throw). */
export function statOrNull(path: string): FileStat | undefined {
  return fs.statSync(path, { throwIfNoEntry: false });
}

/** What a path is without following a link. Throws when it is absent. */
export function lstat(path: string): FileStat {
  return fs.lstatSync(path);
}

/** The path with every link resolved. Throws when it is absent. */
export function realPath(path: string): string {
  return fs.realpathSync(path);
}

/** The path with every link resolved, by the operating system's own resolver (the spelling of the real case on Windows). */
export function realPathNative(path: string): string {
  return fs.realpathSync.native(path);
}

/** Where a symbolic link points. Throws when the path is not a link. */
export function readLink(path: string): string {
  return fs.readlinkSync(path);
}

/** Throws unless the process may write to the path. */
export function checkWritable(path: string): void {
  fs.accessSync(path, fs.constants.W_OK);
}

// -- Writing ----------------------------------------------------------------

/** What a file write takes: `mode` sets the permission bits of a file the write creates. */
export interface WriteOptions {
  mode?: number;
}

/** Write text (UTF-8) to a file, replacing it; `mode` sets the permission bits of a file this creates. */
export function writeText(path: string, text: string, options?: WriteOptions): void {
  fs.writeFileSync(path, text, options);
}

/** Write bytes to a file, replacing it; `mode` sets the permission bits of a file this creates. */
export function writeBytes(path: string, bytes: Uint8Array, options?: WriteOptions): void {
  fs.writeFileSync(path, bytes, options);
}

/** Make a folder and every missing folder above it; an existing folder is no error. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Make one folder whose parent exists. Throws when it exists or the parent is missing. */
export function makeDir(dir: string): void {
  fs.mkdirSync(dir);
}

/** Make a folder with a unique name from a prefix (the prefix's folder must exist) and answer its path. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(prefix);
}

/** Move or rename a file or folder. Throws as renameSync does. */
export function rename(from: string, to: string): void {
  fs.renameSync(from, to);
}

/** Copy one file, replacing the destination when it exists. Throws as copyFileSync does. */
export function copyFile(from: string, to: string): void {
  fs.copyFileSync(from, to);
}

/** Whether a copy takes one source path to its destination. */
export type CopyFilter = (source: string, destination: string) => boolean;

/** What a folder copy takes; the same names as fs.cpSync's, passed through. */
export interface CopyOptions {
  recursive?: boolean;
  force?: boolean;
  errorOnExist?: boolean;
  filter?: CopyFilter;
}

/** Copy a file or (with `recursive`) a folder. */
export function copy(from: string, to: string, options?: CopyOptions): void {
  fs.cpSync(from, to, options);
}

/** Set a file's permission bits (mode). Throws as chmodSync does, an absent file among it. */
export function chmod(path: string, mode: number): void {
  fs.chmodSync(path, mode);
}

/** Make a symbolic link at `path` pointing at `target`. */
export function symlink(target: string, path: string): void {
  fs.symlinkSync(target, path);
}

// -- Removing ---------------------------------------------------------------

/** Remove a file or a whole folder tree; an absent path is no error. */
export function remove(path: string): void {
  fs.rmSync(path, { recursive: true, force: true });
}

/** Remove a file; an absent path is no error (a folder throws). */
export function removeFileIfPresent(path: string): void {
  fs.rmSync(path, { force: true });
}

/** What removing an existing path takes: `recursive` removes a folder tree. */
export interface RemoveOptions {
  recursive?: boolean;
}

/** Remove a path that must exist: a file, or with `recursive` a folder tree. Throws when it is absent. */
export function removeExisting(path: string, options?: RemoveOptions): void {
  if (options?.recursive) fs.rmSync(path, { recursive: true });
  else fs.rmSync(path);
}

/** Remove a file with unlink. Throws when it is absent. */
export function removeFile(path: string): void {
  fs.unlinkSync(path);
}

/** Remove a file in the background; whether it worked is not waited for or reported. */
export function removeFileLater(path: string): void {
  fs.unlink(path, () => {});
}

/** Remove an empty folder. Throws when it is absent or holds anything. */
export function removeEmptyDir(dir: string): void {
  fs.rmdirSync(dir);
}

// -- Descriptors and streams (the lock and durable-write code) ---------------

/** An open file: the number the operating system gives it. Close it with closeDescriptor. */
export type Descriptor = number;

/** Open an existing file (or folder) for reading and answer its descriptor. Throws when it is absent. */
export function openForRead(path: string): Descriptor {
  return fs.openSync(path, 'r');
}

/** Open a file for writing, emptying it or creating it. */
export function openForWrite(path: string): Descriptor {
  return fs.openSync(path, 'w');
}

/** Create a file and open it for writing; throws EEXIST when the name is taken. */
export function openNew(path: string): Descriptor {
  return fs.openSync(path, 'wx');
}

/** Write text or bytes at the descriptor's position. */
export function writeDescriptor(fd: Descriptor, data: string | Uint8Array): void {
  if (typeof data === 'string') fs.writeSync(fd, data);
  else fs.writeSync(fd, data);
}

/** Read up to `length` bytes from the start of an open file into `buffer`; answers how many were read. */
export function readDescriptorHead(fd: Descriptor, buffer: Uint8Array, length: number): number {
  return fs.readSync(fd, buffer, 0, length, 0);
}

/** Flush an open file's content to the disk. */
export function syncDescriptor(fd: Descriptor): void {
  fs.fsyncSync(fd);
}

/** Close an open descriptor; it must not be used again. Throws as closeSync does. */
export function closeDescriptor(fd: Descriptor): void {
  fs.closeSync(fd);
}

/** A stream that writes a file, as node fs answers it. */
export type WriteStream = fs.WriteStream;

/** A stream that writes a file, creating or emptying it. */
export function openWriteStream(path: string): WriteStream {
  return fs.createWriteStream(path);
}
