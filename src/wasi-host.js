// Standalone, zero-dependency WASI Preview 1 Host implementation
// Directly backed by an in-memory Virtual File System (Map, Object, or VFS)
// Compatible with both Node.js and browser environments (ESM and CommonJS)

export const ESUCCESS = 0;
export const EBADF = 8;
export const EEXIST = 20;
export const EINVAL = 28;
export const EISDIR = 31;
export const ENOENT = 44;
export const ENOSYS = 52;
export const ENOTDIR = 54;
export const EPERM = 63;

export class ProcExit extends Error {
  constructor(code, changedFiles = null, deletedFiles = null) {
    super(`Exited with code ${code}`);
    this.code = code;
    this.changedFiles = changedFiles;
    this.deletedFiles = deletedFiles;
  }
}

export function normalizePath(path) {
  if (!path) return '/';
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/').filter(p => p && p !== '.');
  const resolved = [];

  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const result = (isAbsolute ? '/' : '') + resolved.join('/');
  return result === '' ? '/' : result;
}

export class WasiHost {
  constructor(options = {}) {
    this.vfs = options.vfs || new Map();
    this.cwd = options.cwd || '/workspace';
    this.argv = options.argv || ['./a.out'];
    this.environ = options.environ || { USER: 'student', PWD: this.cwd };
    this.stdin = options.stdin || null;
    this.stdout = options.stdout || (() => {});
    this.stderr = options.stderr || options.stdout || (() => {});
    this.getMemory = options.getMemory || null;
    this.onFileSync = options.onFileSync || null;
    this.onFileDelete = options.onFileDelete || null;

    this.preopens = options.preopens || [
      { fd: 3, path: this.cwd, name: '.' },
      { fd: 4, path: '/', name: '/' },
    ];

    this.openFiles = new Map();
    this.nextFd = 10;
    this.changedFiles = new Map();
    this.deletedFiles = new Set();
    this.stdinPos = 0;
    this.inodes = new Map();
    this.nextInode = 100n;
    this.createdDirs = new Set(['/', '/workspace', '/usr', '/bin', '/usr/include', '/usr/lib', '/include', '/lib']);
  }

  _getInode(p) {
    const norm = normalizePath(p);
    if (!this.inodes.has(norm)) {
      this.inodes.set(norm, this.nextInode++);
    }
    return this.inodes.get(norm);
  }

  setMemory(getMemory) {
    this.getMemory = getMemory;
  }

  mem() {
    const memory = typeof this.getMemory === 'function' ? this.getMemory() : this.getMemory;
    if (!memory || !memory.buffer) {
      throw new Error('WASI Host: WebAssembly.Memory is not available or detached.');
    }
    return memory;
  }

  memU8() {
    return new Uint8Array(this.mem().buffer);
  }

  memU32() {
    return new Uint32Array(this.mem().buffer);
  }

  memI64() {
    return new BigInt64Array(this.mem().buffer);
  }

  readStr(offset, len) {
    const u8 = this.memU8();
    let str = '';
    const end = len !== -1 ? offset + len : u8.length;
    for (let i = offset; i < end && u8[i] !== 0; ++i) {
      str += String.fromCharCode(u8[i]);
    }
    return str;
  }

  resolvePath(dirfd, pathStr) {
    let base = this.cwd;
    for (const preopen of this.preopens) {
      if (preopen.fd === dirfd) {
        base = preopen.path;
        break;
      }
    }
    if (this.openFiles.has(dirfd)) {
      base = this.openFiles.get(dirfd).path;
    }

    if (!pathStr || pathStr === '.') return normalizePath(base);
    if (pathStr.startsWith('/')) return normalizePath(pathStr);

    const clean = pathStr.replace(/^\.?\/+/, '');
    if (base === '/workspace' && clean.startsWith('workspace/')) {
      return normalizePath(`/${clean}`);
    }

    const candidate = normalizePath(`${base}/${clean}`);
    if (this._vfsExists(candidate) || this._vfsIsDir(candidate)) {
      return candidate;
    }

    if (base === '/' && this.cwd && this.cwd !== '/') {
      const cleanNoWorkspace = clean.startsWith('workspace/') ? clean.substring('workspace/'.length) : clean;
      const cwdCandidate = normalizePath(`${this.cwd}/${cleanNoWorkspace}`);
      if (this._vfsExists(cwdCandidate) || this._vfsIsDir(cwdCandidate)) {
        return cwdCandidate;
      }
      if (!clean.startsWith('include/') && !clean.startsWith('lib/') && !clean.startsWith('usr/') && !clean.startsWith('bin/')) {
        return cwdCandidate;
      }
    }

    if (clean.startsWith('include/') || clean.startsWith('lib/') || clean.startsWith('usr/') || clean.startsWith('bin/')) {
      const rootCandidate = normalizePath(`/${clean}`);
      if (this._vfsExists(rootCandidate) || this._vfsIsDir(rootCandidate)) {
        return rootCandidate;
      }
    }

    return candidate;
  }

  // File access helpers over VFS, Map, or Object
  _vfsExists(p) {
    if (!this.vfs) return false;
    if (typeof this.vfs.exists === 'function') return this.vfs.exists(p);
    if (this.vfs instanceof Map) return this.vfs.has(p);
    if (typeof this.vfs === 'object') return Object.prototype.hasOwnProperty.call(this.vfs, p);
    return false;
  }

  _vfsIsDir(p) {
    if (!this.vfs) return false;
    if (p === '/' || p === '/workspace') return true;
    if (this.createdDirs && this.createdDirs.has(p)) return true;
    if (typeof this.vfs.stat === 'function') {
      const s = this.vfs.stat(p);
      return s ? Boolean(s.isDir || s.isDirectory) : false;
    }
    if (typeof this.vfs.isDir === 'function') return this.vfs.isDir(p);
    if (this.vfs instanceof Map && this.vfs.has(p)) {
      const item = this.vfs.get(p);
      if (item && typeof item === 'object' && item.isDir !== undefined) return Boolean(item.isDir);
    }
    const prefix = p === '/' ? '/' : `${p}/`;
    if (this.vfs instanceof Map) {
      for (const k of this.vfs.keys()) {
        if (k.startsWith(prefix)) return true;
      }
      return false;
    }
    if (typeof this.vfs === 'object') {
      for (const k of Object.keys(this.vfs)) {
        if (k.startsWith(prefix)) return true;
      }
      return false;
    }
    return false;
  }

  _vfsReadFile(p) {
    if (!this.vfs) return new Uint8Array(0);
    let res = null;
    if (typeof this.vfs.readFile === 'function') {
      res = this.vfs.readFile(p, false);
    } else if (this.vfs instanceof Map) {
      res = this.vfs.get(p);
    } else if (typeof this.vfs === 'object') {
      res = this.vfs[p];
    }
    if (res && typeof res === 'object' && !(res instanceof Uint8Array) && !(res instanceof ArrayBuffer)) {
      if (res.data !== undefined) res = res.data;
      else if (res.contents !== undefined) res = res.contents;
    }
    if (res instanceof Uint8Array) return res;
    if (typeof res === 'string') return new TextEncoder().encode(res);
    if (res instanceof ArrayBuffer) return new Uint8Array(res);
    return new Uint8Array(0);
  }

  _vfsWriteFile(p, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let dirP = p;
    while (dirP.lastIndexOf('/') > 0) {
      dirP = dirP.substring(0, dirP.lastIndexOf('/'));
      this.createdDirs.add(dirP);
    }

    if (this.vfs) {
      if (typeof this.vfs.writeFile === 'function') {
        const lastSlash = p.lastIndexOf('/');
        if (lastSlash > 0) {
          const parentDir = p.substring(0, lastSlash);
          if (!this._vfsExists(parentDir)) {
            try { this.vfs.mkdir(parentDir, true, true); } catch {}
          }
        }
        this.vfs.writeFile(p, bytes, Date.now(), true);
      } else if (this.vfs instanceof Map) {
        this.vfs.set(p, bytes);
      } else if (typeof this.vfs === 'object') {
        this.vfs[p] = bytes;
      }
    }
    this.changedFiles.set(p, bytes);
    this.deletedFiles.delete(p);
    if (this.onFileSync) {
      try { this.onFileSync(p, bytes); } catch {}
    }
  }

  _vfsRemove(p) {
    if (this.vfs) {
      if (typeof this.vfs.remove === 'function') {
        try { this.vfs.remove(p, true, true); } catch {}
      } else if (this.vfs instanceof Map) {
        this.vfs.delete(p);
      } else if (typeof this.vfs === 'object') {
        delete this.vfs[p];
      }
    }
    this.changedFiles.delete(p);
    this.deletedFiles.add(p);
    if (this.onFileDelete) {
      try { this.onFileDelete(p); } catch {}
    }
  }

  _vfsReadDir(p) {
    if (!this.vfs) return [];
    if (typeof this.vfs.readDir === 'function') {
      const items = this.vfs.readDir(p);
      return items.map(i => ({
        name: typeof i === 'string' ? i : i.name,
        isDir: typeof i === 'string' ? this._vfsIsDir(`${p}/${i}`) : Boolean(i.isDir || i.isDirectory),
      }));
    }
    const prefix = p === '/' ? '/' : `${p}/`;
    const seen = new Set();
    const entries = [];
    const keys = (this.vfs instanceof Map) ? Array.from(this.vfs.keys()) : Object.keys(this.vfs || {});
    for (const k of keys) {
      if (k.startsWith(prefix)) {
        const rest = k.substring(prefix.length);
        const name = rest.split('/')[0];
        if (name && !seen.has(name)) {
          seen.add(name);
          entries.push({ name, isDir: rest.includes('/') });
        }
      }
    }
    return entries;
  }

  getImports() {
    const wasi = {
      proc_exit: (code) => {
        throw new ProcExit(code, this.changedFiles, this.deletedFiles);
      },

      fd_prestat_get: (fd, stat_out) => {
        for (const preopen of this.preopens) {
          if (preopen.fd === fd) {
            this.memU8().fill(0, stat_out, stat_out + 8);
            this.memU8()[stat_out] = 0; // __WASI_PREOPENTYPE_DIR
            this.memU32()[(stat_out + 4) >> 2] = preopen.name.length;
            return ESUCCESS;
          }
        }
        return EBADF;
      },

      fd_prestat_dir_name: (fd, path_ptr, path_len) => {
        for (const preopen of this.preopens) {
          if (preopen.fd === fd) {
            const toCopy = Math.min(preopen.name.length, path_len);
            for (let i = 0; i < toCopy; i++) {
              this.memU8()[path_ptr + i] = preopen.name.charCodeAt(i);
            }
            return ESUCCESS;
          }
        }
        return EBADF;
      },

      fd_fdstat_get: (fd, stat_out) => {
        this.memU8().fill(0, stat_out, stat_out + 24);
        const ALL_RIGHTS = 0x1fffffffffffffffn;

        if (fd === 0 || fd === 1 || fd === 2) {
          this.memU8()[stat_out] = 2; // __WASI_FILETYPE_CHARACTER_DEVICE
          this.memI64()[(stat_out + 8) >> 3] = ALL_RIGHTS;
          this.memI64()[(stat_out + 16) >> 3] = ALL_RIGHTS;
          return ESUCCESS;
        }

        for (const preopen of this.preopens) {
          if (preopen.fd === fd) {
            this.memU8()[stat_out] = 3; // __WASI_FILETYPE_DIRECTORY
            this.memI64()[(stat_out + 8) >> 3] = ALL_RIGHTS;
            this.memI64()[(stat_out + 16) >> 3] = ALL_RIGHTS;
            return ESUCCESS;
          }
        }

        const file = this.openFiles.get(fd);
        if (!file) return EBADF;

        this.memU8()[stat_out] = file.isDir ? 3 : 4; // REGULAR_FILE = 4
        if (file.isAppend) {
          this.memU8()[stat_out + 2] = 1; // __WASI_FDFLAG_APPEND
        }
        this.memI64()[(stat_out + 8) >> 3] = ALL_RIGHTS;
        this.memI64()[(stat_out + 16) >> 3] = ALL_RIGHTS;
        return ESUCCESS;
      },

      fd_fdstat_set_flags: (fd, flags) => {
        const file = this.openFiles.get(fd);
        if (file) {
          file.isAppend = (flags & 1) !== 0;
        }
        return ESUCCESS;
      },

      fd_fdstat_set_rights: () => ESUCCESS,

      fd_filestat_get: (fd, stat_out) => {
        this.memU8().fill(0, stat_out, stat_out + 64);
        const nowNs = BigInt(Date.now()) * 1000000n;

        if (fd === 0 || fd === 1 || fd === 2) {
          this.memI64()[stat_out >> 3] = 1n; // dev
          this.memI64()[(stat_out + 8) >> 3] = BigInt(fd); // ino
          this.memU8()[stat_out + 16] = 2; // CHARACTER_DEVICE
          this.memI64()[(stat_out + 24) >> 3] = 1n;
          this.memI64()[(stat_out + 32) >> 3] = 0n;
          this.memI64()[(stat_out + 40) >> 3] = nowNs;
          this.memI64()[(stat_out + 48) >> 3] = nowNs;
          this.memI64()[(stat_out + 56) >> 3] = nowNs;
          return ESUCCESS;
        }

        for (const preopen of this.preopens) {
          if (preopen.fd === fd) {
            this.memI64()[stat_out >> 3] = 1n; // dev
            this.memI64()[(stat_out + 8) >> 3] = this._getInode(preopen.path); // ino
            this.memU8()[stat_out + 16] = 3; // DIRECTORY
            this.memI64()[(stat_out + 24) >> 3] = 1n;
            this.memI64()[(stat_out + 32) >> 3] = 0n;
            this.memI64()[(stat_out + 40) >> 3] = nowNs;
            this.memI64()[(stat_out + 48) >> 3] = nowNs;
            this.memI64()[(stat_out + 56) >> 3] = nowNs;
            return ESUCCESS;
          }
        }

        const file = this.openFiles.get(fd);
        if (!file) return EBADF;

        this.memI64()[stat_out >> 3] = 1n; // dev
        this.memI64()[(stat_out + 8) >> 3] = this._getInode(file.path); // ino

        if (file.isDir) {
          this.memU8()[stat_out + 16] = 3;
          this.memI64()[(stat_out + 24) >> 3] = 1n;
          this.memI64()[(stat_out + 32) >> 3] = 0n;
        } else {
          const data = this._vfsReadFile(file.path);
          this.memU8()[stat_out + 16] = 4;
          this.memI64()[(stat_out + 24) >> 3] = 1n;
          this.memI64()[(stat_out + 32) >> 3] = BigInt(data.length);
        }

        this.memI64()[(stat_out + 40) >> 3] = nowNs;
        this.memI64()[(stat_out + 48) >> 3] = nowNs;
        this.memI64()[(stat_out + 56) >> 3] = nowNs;
        return ESUCCESS;
      },

      fd_filestat_set_size: (fd, size) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canWrite) return EBADF;
        const targetLen = Math.max(0, Number(size));
        const data = this._vfsReadFile(file.path);
        const nextData = new Uint8Array(targetLen);
        nextData.set(data.subarray(0, Math.min(data.length, targetLen)));
        this._vfsWriteFile(file.path, nextData);
        return ESUCCESS;
      },

      fd_filestat_set_times: () => ESUCCESS,

      path_filestat_get: (dirfd, flags, path_ptr, path_len, stat_out) => {
        const pathStr = this.readStr(path_ptr, path_len);
        const fullPath = this.resolvePath(dirfd, pathStr);

        this.memU8().fill(0, stat_out, stat_out + 64);
        const nowNs = BigInt(Date.now()) * 1000000n;
        this.memI64()[stat_out >> 3] = 1n; // dev
        this.memI64()[(stat_out + 8) >> 3] = this._getInode(fullPath); // ino

        if (this._vfsIsDir(fullPath)) {
          this.memU8()[stat_out + 16] = 3; // DIRECTORY
          this.memI64()[(stat_out + 24) >> 3] = 1n;
          this.memI64()[(stat_out + 32) >> 3] = 0n;
          this.memI64()[(stat_out + 40) >> 3] = nowNs;
          this.memI64()[(stat_out + 48) >> 3] = nowNs;
          this.memI64()[(stat_out + 56) >> 3] = nowNs;
          return ESUCCESS;
        }

        if (this._vfsExists(fullPath)) {
          const data = this._vfsReadFile(fullPath);
          this.memU8()[stat_out + 16] = 4; // REGULAR_FILE
          this.memI64()[(stat_out + 24) >> 3] = 1n;
          this.memI64()[(stat_out + 32) >> 3] = BigInt(data.length);
          this.memI64()[(stat_out + 40) >> 3] = nowNs;
          this.memI64()[(stat_out + 48) >> 3] = nowNs;
          this.memI64()[(stat_out + 56) >> 3] = nowNs;
          return ESUCCESS;
        }

        return ENOENT;
      },

      path_filestat_set_times: () => ESUCCESS,

      path_open: (dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, opened_fd_ptr) => {
        const pathStr = this.readStr(path_ptr, path_len);
        const fullPath = this.resolvePath(dirfd, pathStr);

        const WASI_O_CREAT = 1;
        const WASI_O_DIRECTORY = 2;
        const WASI_O_EXCL = 4;
        const WASI_O_TRUNC = 8;
        const WASI_FDFLAG_APPEND = 1;

        if (oflags & WASI_O_DIRECTORY) {
          if (this._vfsIsDir(fullPath)) {
            const fd = this.nextFd++;
            this.openFiles.set(fd, {
              fd,
              path: fullPath,
              isDir: true,
              canRead: true,
              canWrite: false,
              isAppend: false,
              cursor: 0,
            });
            this.memU32()[opened_fd_ptr >> 2] = fd;
            return ESUCCESS;
          }
          return this._vfsExists(fullPath) ? ENOTDIR : ENOENT;
        }

        const exists = this._vfsExists(fullPath);

        if (exists && this._vfsIsDir(fullPath)) {
          return EISDIR;
        }

        if (exists) {
          if ((oflags & WASI_O_CREAT) && (oflags & WASI_O_EXCL)) {
            return EEXIST;
          }
          if (oflags & WASI_O_TRUNC) {
            this._vfsWriteFile(fullPath, new Uint8Array(0));
          }
        } else {
          if (!(oflags & WASI_O_CREAT)) {
            return ENOENT;
          }
          this._vfsWriteFile(fullPath, new Uint8Array(0));
        }

        const rightsBig = typeof fs_rights_base === 'bigint' ? fs_rights_base : BigInt(fs_rights_base || 0);
        const canRead = (rightsBig === 0n) || ((rightsBig & (1n << 1n)) !== 0n);
        const canWrite = (rightsBig === 0n)
          ? Boolean((oflags & (WASI_O_CREAT | WASI_O_TRUNC)) || (fdflags & WASI_FDFLAG_APPEND))
          : ((rightsBig & (1n << 6n)) !== 0n);
        const isAppend = (fdflags & WASI_FDFLAG_APPEND) !== 0;

        const curData = this._vfsReadFile(fullPath);
        const fd = this.nextFd++;
        this.openFiles.set(fd, {
          fd,
          path: fullPath,
          isDir: false,
          canRead,
          canWrite,
          isAppend,
          cursor: isAppend ? curData.length : 0,
        });

        this.memU32()[opened_fd_ptr >> 2] = fd;
        return ESUCCESS;
      },

      fd_close: (fd) => {
        if (fd >= 0 && fd <= 5) return ESUCCESS;
        this.openFiles.delete(fd);
        return ESUCCESS;
      },

      fd_read: (fd, iovs, iovs_len, nread_out) => {
        if (fd === 0) {
          if (typeof this.stdin === 'function') {
            return this.stdin(iovs, iovs_len, nread_out, this);
          }
          if (this.stdin && (this.stdin instanceof Uint8Array || Array.isArray(this.stdin))) {
            const preloaded = this.stdin;
            let totalRead = 0;
            for (let i = 0; i < iovs_len; i++) {
              const bufPtr = this.memU32()[(iovs >> 2) + i * 2];
              const bufLen = this.memU32()[(iovs >> 2) + i * 2 + 1];
              const available = preloaded.length - this.stdinPos;
              if (available > 0) {
                const toCopy = Math.min(bufLen, available);
                this.memU8().set(preloaded.subarray(this.stdinPos, this.stdinPos + toCopy), bufPtr);
                this.stdinPos += toCopy;
                totalRead += toCopy;
                break;
              }
            }
            this.memU32()[nread_out >> 2] = totalRead;
            return ESUCCESS;
          }
          this.memU32()[nread_out >> 2] = 0;
          return ESUCCESS;
        }

        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canRead) return EBADF;

        const data = this._vfsReadFile(file.path);
        let totalRead = 0;

        for (let i = 0; i < iovs_len; i++) {
          const ptr = this.memU32()[(iovs >> 2) + i * 2];
          const len = this.memU32()[(iovs >> 2) + i * 2 + 1];
          if (len <= 0) continue;

          const available = Math.max(0, data.length - file.cursor);
          if (available === 0) break;

          const toCopy = Math.min(len, available);
          this.memU8().set(data.subarray(file.cursor, file.cursor + toCopy), ptr);
          file.cursor += toCopy;
          totalRead += toCopy;

          if (toCopy < len) break;
        }

        this.memU32()[nread_out >> 2] = totalRead;
        return ESUCCESS;
      },

      fd_pread: (fd, iovs, iovs_len, offset, nread_out) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canRead) return EBADF;
        const data = this._vfsReadFile(file.path);
        let pos = Number(offset);
        let totalRead = 0;

        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = this.memU32()[(iovs >> 2) + i * 2];
          const bufLen = this.memU32()[(iovs >> 2) + i * 2 + 1];
          if (bufLen <= 0) continue;

          const available = Math.max(0, data.length - pos);
          if (available === 0) break;

          const toCopy = Math.min(bufLen, available);
          this.memU8().set(data.subarray(pos, pos + toCopy), bufPtr);
          pos += toCopy;
          totalRead += toCopy;

          if (toCopy < bufLen) break;
        }

        this.memU32()[nread_out >> 2] = totalRead;
        return ESUCCESS;
      },

      fd_write: (fd, iovs, iovs_len, nwritten_out) => {
        if (fd === 1 || fd === 2) {
          let totalWritten = 0;
          let text = '';
          for (let i = 0; i < iovs_len; i++) {
            const ptr = this.memU32()[(iovs >> 2) + i * 2];
            const len = this.memU32()[(iovs >> 2) + i * 2 + 1];
            text += this.readStr(ptr, len);
            totalWritten += len;
          }
          this.memU32()[nwritten_out >> 2] = totalWritten;
          if (fd === 1) this.stdout(text);
          else this.stderr(text);
          return ESUCCESS;
        }

        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canWrite) return EBADF;

        let data = this._vfsReadFile(file.path);
        let totalWritten = 0;

        for (let i = 0; i < iovs_len; i++) {
          const ptr = this.memU32()[(iovs >> 2) + i * 2];
          const len = this.memU32()[(iovs >> 2) + i * 2 + 1];
          if (len <= 0) continue;

          if (file.isAppend) {
            file.cursor = data.length;
          }

          const needed = file.cursor + len;
          if (needed > data.length) {
            const nextData = new Uint8Array(needed);
            nextData.set(data);
            data = nextData;
          }

          data.set(this.memU8().subarray(ptr, ptr + len), file.cursor);
          file.cursor += len;
          totalWritten += len;
        }

        this._vfsWriteFile(file.path, data);
        this.memU32()[nwritten_out >> 2] = totalWritten;
        return ESUCCESS;
      },

      fd_pwrite: (fd, iovs, iovs_len, offset, nwritten_out) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canWrite) return EBADF;

        let data = this._vfsReadFile(file.path);
        let pos = Number(offset);
        let totalWritten = 0;

        for (let i = 0; i < iovs_len; i++) {
          const ptr = this.memU32()[(iovs >> 2) + i * 2];
          const len = this.memU32()[(iovs >> 2) + i * 2 + 1];
          if (len <= 0) continue;

          const needed = pos + len;
          if (needed > data.length) {
            const nextData = new Uint8Array(needed);
            nextData.set(data);
            data = nextData;
          }

          data.set(this.memU8().subarray(ptr, ptr + len), pos);
          pos += len;
          totalWritten += len;
        }

        this._vfsWriteFile(file.path, data);
        this.memU32()[nwritten_out >> 2] = totalWritten;
        return ESUCCESS;
      },

      fd_seek: (fd, offset, whence, newoffset_out) => {
        if (fd === 0 || fd === 1 || fd === 2) return ESUCCESS;
        const file = this.openFiles.get(fd);
        if (!file || file.isDir) return EBADF;

        const data = this._vfsReadFile(file.path);
        const offNum = Number(offset);
        let target = file.cursor;

        if (whence === 0) target = offNum;
        else if (whence === 1) target = file.cursor + offNum;
        else if (whence === 2) target = data.length + offNum;
        else return EINVAL;

        if (target < 0) return EINVAL;

        file.cursor = target;
        this.memI64()[newoffset_out >> 3] = BigInt(file.cursor);
        return ESUCCESS;
      },

      fd_tell: (fd, offset_out) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir) return EBADF;
        this.memI64()[offset_out >> 3] = BigInt(file.cursor);
        return ESUCCESS;
      },

      fd_sync: (fd) => {
        const file = this.openFiles.get(fd);
        if (file && this.onFileSync) {
          const data = this._vfsReadFile(file.path);
          try { this.onFileSync(file.path, data); } catch {}
        }
        return ESUCCESS;
      },

      fd_datasync: (fd) => wasi.fd_sync(fd),
      fd_allocate: () => ESUCCESS,
      fd_advise: () => ESUCCESS,
      fd_renumber: () => EBADF,

      fd_readdir: (fd, buf, buf_len, cookie, nwritten_out) => {
        let dirPath = this.cwd;
        for (const preopen of this.preopens) {
          if (preopen.fd === fd) {
            dirPath = preopen.path;
            break;
          }
        }
        if (this.openFiles.has(fd) && this.openFiles.get(fd).isDir) {
          dirPath = this.openFiles.get(fd).path;
        }

        const entries = this._vfsReadDir(dirPath);
        const cookieIndex = Number(cookie);
        let written = 0;

        for (let i = cookieIndex; i < entries.length; i++) {
          const entry = entries[i];
          const nameBytes = new TextEncoder().encode(entry.name);
          const entryLen = 24 + nameBytes.length;
          if (written + entryLen > buf_len) break;

          const base = buf + written;
          this.memU8().fill(0, base, base + 24);
          this.memI64()[base >> 3] = BigInt(i + 1); // d_next
          this.memI64()[(base + 8) >> 3] = this._getInode(`${dirPath}/${entry.name}`); // d_ino
          this.memU32()[(base + 16) >> 2] = nameBytes.length; // d_namlen
          this.memU8()[base + 20] = entry.isDir ? 3 : 4; // d_type

          this.memU8().set(nameBytes, base + 24);
          written += entryLen;
        }

        this.memU32()[nwritten_out >> 2] = written;
        return ESUCCESS;
      },

      path_unlink_file: (dirfd, path_ptr, path_len) => {
        const pathStr = this.readStr(path_ptr, path_len);
        const fullPath = this.resolvePath(dirfd, pathStr);
        this._vfsRemove(fullPath);
        return ESUCCESS;
      },

      path_remove_directory: (dirfd, path_ptr, path_len) => {
        const pathStr = this.readStr(path_ptr, path_len);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (this.vfs && typeof this.vfs.rmdir === 'function') {
          try { this.vfs.rmdir(fullPath, true); } catch {}
        }
        if (this.createdDirs) {
          this.createdDirs.delete(fullPath);
        }
        return ESUCCESS;
      },

      path_create_directory: (dirfd, path_ptr, path_len) => {
        const pathStr = this.readStr(path_ptr, path_len);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (this.vfs && typeof this.vfs.mkdir === 'function') {
          try { this.vfs.mkdir(fullPath, true, true); } catch {}
        }
        if (this.createdDirs) {
          this.createdDirs.add(fullPath);
        }
        return ESUCCESS;
      },

      path_rename: (old_dirfd, old_path_ptr, old_path_len, new_dirfd, new_path_ptr, new_path_len) => {
        const oldStr = this.readStr(old_path_ptr, old_path_len);
        const newStr = this.readStr(new_path_ptr, new_path_len);
        const oldFull = this.resolvePath(old_dirfd, oldStr);
        const newFull = this.resolvePath(new_dirfd, newStr);

        if (this.vfs && typeof this.vfs.rename === 'function') {
          try {
            this.vfs.rename(oldFull, newFull, true);
          } catch (e) {
            return EEXIST;
          }
        } else {
          const d = this._vfsReadFile(oldFull);
          if (d) {
            this._vfsWriteFile(newFull, d);
            this._vfsRemove(oldFull);
          }
        }
        return ESUCCESS;
      },

      path_readlink: () => ENOSYS,
      path_symlink: () => ENOSYS,
      path_link: () => ENOSYS,

      environ_sizes_get: (count_out, size_out) => {
        const keys = Object.keys(this.environ);
        let size = 0;
        for (const k of keys) {
          size += k.length + String(this.environ[k]).length + 2;
        }
        this.memU32()[count_out >> 2] = keys.length;
        this.memU32()[size_out >> 2] = size;
        return ESUCCESS;
      },

      environ_get: (ptrs, buf) => {
        let b = buf;
        let p = ptrs >> 2;
        for (const k of Object.keys(this.environ)) {
          this.memU32()[p++] = b;
          const entry = `${k}=${this.environ[k]}\0`;
          for (let i = 0; i < entry.length; i++) {
            this.memU8()[b++] = entry.charCodeAt(i);
          }
        }
        return ESUCCESS;
      },

      args_sizes_get: (argc_out, size_out) => {
        let size = 0;
        for (const a of this.argv) {
          size += a.length + 1;
        }
        this.memU32()[argc_out >> 2] = this.argv.length;
        this.memU32()[size_out >> 2] = size;
        return ESUCCESS;
      },

      args_get: (ptrs, buf) => {
        let b = buf;
        let p = ptrs >> 2;
        for (const a of this.argv) {
          this.memU32()[p++] = b;
          for (let i = 0; i < a.length; i++) {
            this.memU8()[b++] = a.charCodeAt(i);
          }
          this.memU8()[b++] = 0;
        }
        return ESUCCESS;
      },

      clock_time_get: (clock_id, precision, time_out) => {
        const now = BigInt(Date.now()) * 1000000n;
        this.memI64()[time_out >> 3] = now;
        return ESUCCESS;
      },

      clock_res_get: (clock_id, res_out) => {
        this.memI64()[res_out >> 3] = 1000n;
        return ESUCCESS;
      },

      random_get: (buf, len) => {
        crypto.getRandomValues(this.memU8().subarray(buf, buf + len));
        return ESUCCESS;
      },

      poll_oneoff: () => ESUCCESS,
      sched_yield: () => ESUCCESS,
    };

    return new Proxy(wasi, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => ESUCCESS;
      }
    });
  }

  getImportObject() {
    return this.createImportObject();
  }

  createImportObject() {
    const wasi = this.getImports();
    return {
      wasi_snapshot_preview1: wasi,
      wasi_unstable: wasi,
      env: new Proxy({}, {
        get(t, p) {
          if (p in t) return t[p];
          return () => 0;
        }
      }),
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WasiHost,
    ProcExit,
    normalizePath,
    ESUCCESS,
    EBADF,
    EEXIST,
    EINVAL,
    EISDIR,
    ENOENT,
    ENOSYS,
    ENOTDIR,
    EPERM,
  };
}
