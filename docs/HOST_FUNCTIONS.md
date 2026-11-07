# WebAssembly Host-Assisted Functions Specification

**Module:** `clang-wasi`  
**Target Triple:** `wasm32-wasip1`  
**Target Specification:** WASI Preview 1 (`wasi_snapshot_preview1`) + In-Memory VFS  
**Reference Host:** `src/wasi-host.js` / `examples/host-reference.js`

---

## 1. Architectural Contract & Principles

`clang-wasi` provides WebAssembly-native toolchain binaries (`llvm-box.wasm`, including `clang`, `clang++`, `wasm-ld`, `llvm-ar`, `llvm-nm`, etc.) and compiles C/C++ code targeting WebAssembly.

### 1.1 Strict Single-Threaded WASI Preview 1 Invariant
1. **Target Triple:** All binaries target `wasm32-wasip1`. Multithreading is strictly disabled (`-DLLVM_ENABLE_THREADS=OFF`).
2. **Standard Runtimes:** The binaries run out of the box in pure WASI runtimes (Node.js, Wasmtime, Wasmer, browser Web Workers) without requiring WebAssembly threads, shared memory (`SharedArrayBuffer`), or secondary emulators.
3. **Pure WASI Contract:** The multicall binary `llvm-box.wasm` imports **only** standard WASI Preview 1 system calls under the `wasi_snapshot_preview1` namespace.
4. **Zero-MemFS Direct VFS:** The host must provide an in-memory Virtual File System (VFS) directly backed by JavaScript memory (`Map<string, Uint8Array>` or equivalent), avoiding double-buffering shims like `memfs.wasm`.

### 1.2 Decoupling of Foreign Shell Hooks
Earlier revisions of shell runners embedded foreign BusyBox-specific shell hooks (`__host_pipe`, `__host_dup`, `__host_dup2`, `__host_winsize`, `__host_winch`, `__host_interrupt`, `__host_sock_*`, `__host_builtin_*`, `wasi_host_spawn`). 
- **Decoupled Status:** These shell extensions are **foreign to the LLVM/Clang compiler toolchain** and have been completely decoupled and removed from `clang-wasi`.
- **Compiler Requirements:** The toolchain operates strictly via pure WASI Preview 1 and direct VFS file operations.
- **Extensibility:** If an external downstream integrator (such as `wasm-c-ide` or an interactive terminal shell) requires additional environment hooks, the reference host provides a permissive proxy fallback via `createImportObject(customEnv)`.

---

## 2. Module Import Namespaces

The WebAssembly instantiation import object comprises:

| Namespace | Status | Description |
|---|---|---|
| `wasi_snapshot_preview1` | **Authoritative (Required)** | Primary standard WASI Preview 1 system call interface. Required by `llvm-box.wasm` (30 functions). |
| `wasi_unstable` | **Alias (Compatibility)** | Direct alias to `wasi_snapshot_preview1` for legacy WASI toolchains. |
| `env` | **Decoupled / Optional** | Permissive proxy (`() => 0`) supporting downstream custom user extensions. Contains no hardcoded compiler dependencies. |

---

## 3. Data Structures & Memory Layouts

All pointer arguments refer to byte offsets within the instance's linear memory (`WebAssembly.Memory`). Numeric structures are encoded in **little-endian** byte order.

### 3.1 `__wasi_ciovec_t` (Outbound Scatter/Gather Buffer Descriptor)
Used by `fd_write` and `fd_pwrite`. Size: 8 bytes.
```
Offset  Size  Field  Description
0       4     buf    Pointer to byte buffer in Wasm linear memory (u32)
4       4     buf_len Byte length of buffer (u32)
```

### 3.2 `__wasi_iovec_t` (Inbound Scatter/Gather Buffer Descriptor)
Used by `fd_read` and `fd_pread`. Size: 8 bytes.
```
Offset  Size  Field  Description
0       4     buf    Pointer to destination buffer in Wasm linear memory (u32)
4       4     buf_len Maximum bytes to read into buffer (u32)
```

### 3.3 `__wasi_fdstat_t` (File Descriptor Flags and Rights)
Used by `fd_fdstat_get` and `fd_fdstat_set_flags`. Size: 24 bytes.
```
Offset  Size  Field          Description
0       1     fs_filetype    Type of file (1: UNKNOWN, 2: BLOCK, 3: CHAR, 4: DIR, 7: REGULAR)
1       1     pad            Alignment padding (0)
2       2     fs_flags       Descriptor flags (bit 0: APPEND, bit 1: DSYNC, bit 2: NONBLOCK, etc.)
4       4     pad2           Alignment padding (0)
8       8     fs_rights_base 64-bit integer bitmask of valid operations on this descriptor
16      8     fs_rights_inh  64-bit integer bitmask of inherited operations on child descriptors
```

### 3.4 `__wasi_filestat_t` (File Metadata Buffer)
Used by `fd_filestat_get` and `path_filestat_get`. Size: 64 bytes.
```
Offset  Size  Field      Description
0       8     dev        Device identifier (must be non-zero, e.g. 1n, to prevent directory loop aliasing)
8       8     ino        64-bit unique inode number
16      1     filetype   File type (3: DIR, 4: CHAR, 7: REGULAR)
17      7     pad        Alignment padding
24      4     nlink      Link count (typically 1 for regular files, 2 for directories)
28      4     pad2       Alignment padding
32      8     size       File size in bytes (BigInt u64)
40      8     atim       Access timestamp in nanoseconds (BigInt u64)
48      8     mtim       Modification timestamp in nanoseconds (BigInt u64)
56      8     ctim       Status change timestamp in nanoseconds (BigInt u64)
```

### 3.5 `__wasi_dirent_t` (Directory Entry Header)
Used by `fd_readdir`. Size: 24 bytes followed immediately by `d_namlen` UTF-8 bytes.
```
Offset  Size  Field      Description
0       8     d_next     Cookie pointing to the next entry index (BigInt u64)
8       8     d_ino      Inode number of the entry (BigInt u64)
16      4     d_namlen   Byte length of file/directory name (u32)
20      1     d_type     File type (3: DIR, 7: REGULAR, etc.)
21      3     pad        Alignment padding (0)
24      N     name       UTF-8 encoded entry name (unpadded, length = d_namlen)
```

### 3.6 `__wasi_prestat_t` (Preopened Resource Descriptor)
Used by `fd_prestat_get`. Size: 8 bytes.
```
Offset  Size  Field         Description
0       1     pr_type       Type of preopened resource (0: __WASI_PREOPENTYPE_DIR)
1       3     pad           Alignment padding (0)
4       4     pr_name_len   Length of preopened directory name string in bytes (u32)
```

---

## 4. Standard WASI Preview 1 Functions (`wasi_snapshot_preview1`)

The table below lists all 30 functions imported and invoked by `llvm-box.wasm`:

### 4.1 Process Arguments and Environment

#### `args_get(argv_ptr: i32, argv_buf: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `crt1.o` runtime initialization (`__main_void`).
- **Signature:** `(argv_ptr: i32, argv_buf: i32) -> i32`
- **Semantics:** Writes pointers to each argument string at `argv_ptr` (each 4 bytes, little-endian) and copies null-terminated argument strings (`arg\0`) consecutively into `argv_buf`.
- **Return Code:** `0` (`ESUCCESS`).

#### `args_sizes_get(argc_out: i32, argv_buf_size_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `crt1.o` runtime initialization (`__main_void`).
- **Signature:** `(argc_out: i32, argv_buf_size_out: i32) -> i32`
- **Semantics:** Stores argument count at `argc_out` (u32) and total byte size of all null-terminated argument strings at `argv_buf_size_out` (u32).
- **Return Code:** `0` (`ESUCCESS`).

#### `environ_get(environ_ptr: i32, environ_buf: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `libc` runtime startup (`getenv`, `environ`).
- **Signature:** `(environ_ptr: i32, environ_buf: i32) -> i32`
- **Semantics:** Writes pointers to each environment entry at `environ_ptr` and copies null-terminated `KEY=VALUE\0` strings consecutively into `environ_buf`.
- **Return Code:** `0` (`ESUCCESS`).

#### `environ_sizes_get(environ_count_out: i32, environ_buf_size_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `libc` runtime startup (`getenv`, `environ`).
- **Signature:** `(environ_count_out: i32, environ_buf_size_out: i32) -> i32`
- **Semantics:** Stores environment string count at `environ_count_out` (u32) and total byte size at `environ_buf_size_out` (u32).
- **Return Code:** `0` (`ESUCCESS`).

#### `proc_exit(exit_code: i32) -> void`
- **Triggering C / POSIX Mechanism:** `exit()`, `abort()`, `return` from `main()`.
- **Signature:** `(exit_code: i32) -> void`
- **Semantics:** Terminates execution immediately with `exit_code`. The host handles this by throwing a `ProcExit(code)` error caught by the execution runner.

---

### 4.2 File Descriptor Operations

#### `fd_close(fd: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `close(fd)`, `fclose(fp)`.
- **Signature:** `(fd: i32) -> i32`
- **Semantics:** Closes and removes the file descriptor from the host's open file table. Descriptors 0, 1, and 2 are preserved.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_fdstat_get(fd: i32, stat_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `fstat`, `isatty`, `fcntl`.
- **Signature:** `(fd: i32, stat_out: i32) -> i32`
- **Semantics:** Writes a 24-byte `__wasi_fdstat_t` structure at `stat_out`. For TTY descriptors (0, 1, 2), character device type (`2`) is reported and seek/tell rights are stripped so `isatty()` in `wasi-libc` detects a terminal correctly.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_fdstat_set_flags(fd: i32, flags: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `fcntl(fd, F_SETFL, flags)`.
- **Signature:** `(fd: i32, flags: i32) -> i32`
- **Semantics:** Updates descriptor flags (e.g., `FDFLAG_APPEND`).
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_filestat_get(fd: i32, buf_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `fstat(fd, &st)`.
- **Signature:** `(fd: i32, buf_out: i32) -> i32`
- **Semantics:** Fills a 64-byte `__wasi_filestat_t` at `buf_out` using the open file's VFS metadata.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_filestat_set_size(fd: i32, size: i64) -> i32`
- **Triggering C / POSIX Mechanism:** `ftruncate(fd, length)`.
- **Signature:** `(fd: i32, size: i64) -> i32`
- **Semantics:** Truncates or extends the file buffer in the VFS to `size` bytes.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_filestat_set_times(fd: i32, atim: i64, mtim: i64, fst_flags: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `futimens(fd, times)`.
- **Signature:** `(fd: i32, atim: i64, mtim: i64, fst_flags: i32) -> i32`
- **Semantics:** Updates access and modification timestamps in the VFS entry.
- **Return Code:** `0` (`ESUCCESS`).

#### `fd_read(fd: i32, iovs: i32, iovs_len: i32, nread_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `read(fd, buf, len)`, `fread(ptr, 1, len, fp)`.
- **Signature:** `(fd: i32, iovs: i32, iovs_len: i32, nread_out: i32) -> i32`
- **Semantics:** Scatter reads from `fd` into the array of `__wasi_iovec_t` structures. For `fd 0`, delegates to stdin handler (synchronous buffer or `Atomics.wait`). For regular files, copies bytes from VFS into linear memory and updates descriptor offset. Writes total bytes read to `nread_out` (u32).
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_pread(fd: i32, iovs: i32, iovs_len: i32, offset: i64, nread_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `pread(fd, buf, len, offset)`.
- **Signature:** `(fd: i32, iovs: i32, iovs_len: i32, offset: i64, nread_out: i32) -> i32`
- **Semantics:** Scatter reads from VFS file at explicit `offset` without mutating the descriptor's seek offset. Writes total read count to `nread_out`.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `write(fd, buf, len)`, `printf(...)`, `fwrite(...)`.
- **Signature:** `(fd: i32, iovs: i32, iovs_len: i32, nwritten_out: i32) -> i32`
- **Semantics:** Gather writes from array of `__wasi_ciovec_t`. For `fd 1` / `fd 2`, decodes UTF-8 and passes string to `stdout` / `stderr` callbacks. For regular files, writes chunks into VFS buffer and updates file size. Writes total written to `nwritten_out`.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_pwrite(fd: i32, iovs: i32, iovs_len: i32, offset: i64, nwritten_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `pwrite(fd, buf, len, offset)`.
- **Signature:** `(fd: i32, iovs: i32, iovs_len: i32, offset: i64, nwritten_out: i32) -> i32`
- **Semantics:** Gather writes at explicit `offset` without mutating descriptor offset.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_seek(fd: i32, offset: i64, whence: i32, newoffset_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `lseek(fd, offset, whence)`.
- **Signature:** `(fd: i32, offset: i64, whence: i32, newoffset_out: i32) -> i32`
- **Semantics:** Updates seek position (`whence = 0: SET`, `1: CUR`, `2: END`). Writes resulting offset (u64) to `newoffset_out`.
- **Return Code:** `0` (`ESUCCESS`), `8` (`EBADF`), or `28` (`EINVAL`).

#### `fd_tell(fd: i32, offset_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `ftell(fp)`.
- **Signature:** `(fd: i32, offset_out: i32) -> i32`
- **Semantics:** Returns current descriptor offset as u64 at `offset_out`.
- **Return Code:** `0` (`ESUCCESS`).

#### `fd_sync(fd: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `fsync(fd)`.
- **Signature:** `(fd: i32) -> i32`
- **Semantics:** Flushes VFS buffers and invokes `onFileSync` callback if provided.
- **Return Code:** `0` (`ESUCCESS`).

#### `fd_readdir(fd: i32, buf: i32, buf_len: i32, cookie: i64, nwritten_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `readdir(dirp)`, `opendir(...)`.
- **Signature:** `(fd: i32, buf: i32, buf_len: i32, cookie: i64, nwritten_out: i32) -> i32`
- **Semantics:** Serializes `__wasi_dirent_t` records into `buf` up to `buf_len`. Resumes from index indicated by `cookie`. Uses `DataView` for safe unaligned writes. Writes total serialized byte count to `nwritten_out`.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_prestat_get(fd: i32, prestat_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `wasi-libc` preopened directory enumeration (`__wasilibc_populate_preopens`).
- **Signature:** `(fd: i32, prestat_out: i32) -> i32`
- **Semantics:** Advertises directory descriptor capabilities (e.g. `fd 3` for `.` and `fd 4` for `/`). Populates 8-byte `__wasi_prestat_t` layout (`pr_type = 0`, `pr_name_len`).
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

#### `fd_prestat_dir_name(fd: i32, path_out: i32, path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `wasi-libc` preopen registration.
- **Signature:** `(fd: i32, path_out: i32, path_len: i32) -> i32`
- **Semantics:** Writes the preopened directory name (e.g. `.` or `/`) as UTF-8 string into `path_out`.
- **Return Code:** `0` (`ESUCCESS`) or `8` (`EBADF`).

---

### 4.3 Path and Filesystem Operations

#### `path_open(dirfd: i32, dirflags: i32, path_ptr: i32, path_len: i32, oflags: i32, fs_rights_base: i64, fs_rights_inheriting: i64, fdflags: i32, fd_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `open(...)`, `fopen(...)`, `creat(...)`.
- **Signature:** `(dirfd: i32, dirflags: i32, path_ptr: i32, path_len: i32, oflags: i32, fs_rights_base: i64, fs_rights_inheriting: i64, fdflags: i32, fd_out: i32) -> i32`
- **Semantics:** Resolves path relative to `dirfd` preopen base. Handles `O_CREAT` (create file), `O_TRUNC` (truncate), `O_EXCL` (fail if exists), and `O_DIRECTORY` (require directory). Allocates new file descriptor starting at `fd >= 10`. Writes new descriptor to `fd_out`.
- **Return Code:** `0` (`ESUCCESS`), `44` (`ENOENT`), `20` (`EEXIST`), or `54` (`ENOTDIR`).

#### `path_create_directory(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `mkdir(path, mode)`.
- **Signature:** `(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Semantics:** Creates directory record in VFS.
- **Return Code:** `0` (`ESUCCESS`), `20` (`EEXIST`), or `44` (`ENOENT`).

#### `path_filestat_get(fd: i32, flags: i32, path_ptr: i32, path_len: i32, buf_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `stat(path, &st)`, `lstat(path, &st)`.
- **Signature:** `(fd: i32, flags: i32, path_ptr: i32, path_len: i32, buf_out: i32) -> i32`
- **Semantics:** Queries metadata for path directly without opening a descriptor. Populates 64-byte `__wasi_filestat_t` at `buf_out`.
- **Return Code:** `0` (`ESUCCESS`) or `44` (`ENOENT`).

#### `path_unlink_file(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `unlink(path)`, `remove(path)`.
- **Signature:** `(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Semantics:** Removes file entry from VFS and triggers `onFileDelete` callback if present.
- **Return Code:** `0` (`ESUCCESS`), `44` (`ENOENT`), or `31` (`EISDIR`).

#### `path_remove_directory(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `rmdir(path)`.
- **Signature:** `(fd: i32, path_ptr: i32, path_len: i32) -> i32`
- **Semantics:** Removes empty directory entry from VFS.
- **Return Code:** `0` (`ESUCCESS`), `44` (`ENOENT`), or `54` (`ENOTDIR`).

#### `path_rename(old_fd: i32, old_path_ptr: i32, old_path_len: i32, new_fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `rename(old, new)`.
- **Signature:** `(old_fd: i32, old_path_ptr: i32, old_path_len: i32, new_fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Semantics:** Atomically renames or relocates entry in the VFS Map.
- **Return Code:** `0` (`ESUCCESS`), `44` (`ENOENT`).

#### `path_link(old_fd: i32, old_flags: i32, old_path_ptr: i32, old_path_len: i32, new_fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `link(old, new)`.
- **Signature:** `(old_fd: i32, old_flags: i32, old_path_ptr: i32, old_path_len: i32, new_fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Semantics:** Creates hard link alias sharing underlying byte buffer in VFS.
- **Return Code:** `0` (`ESUCCESS`).

#### `path_symlink(old_path_ptr: i32, old_path_len: i32, fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `symlink(target, linkpath)`.
- **Signature:** `(old_path_ptr: i32, old_path_len: i32, fd: i32, new_path_ptr: i32, new_path_len: i32) -> i32`
- **Semantics:** Registers symbolic link entry pointing to target string.
- **Return Code:** `0` (`ESUCCESS`).

#### `path_readlink(fd: i32, path_ptr: i32, path_len: i32, buf_out: i32, buf_len: i32, nwritten_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `readlink(path, buf, bufsiz)`.
- **Signature:** `(fd: i32, path_ptr: i32, path_len: i32, buf_out: i32, buf_len: i32, nwritten_out: i32) -> i32`
- **Semantics:** Resolves symlink target string into `buf_out`. Writes bytes copied to `nwritten_out`.
- **Return Code:** `0` (`ESUCCESS`) or `44` (`ENOENT`).

---

### 4.4 Clock, Polling, and Cryptography

#### `clock_time_get(clock_id: i32, precision: i64, time_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `clock_gettime`, `gettimeofday`, `time(...)`.
- **Signature:** `(clock_id: i32, precision: i64, time_out: i32) -> i32`
- **Semantics:** Writes high-resolution timestamp (nanoseconds as u64) to `time_out`. Supports `CLOCKID_REALTIME = 0` (via `Date.now()`) and `CLOCKID_MONOTONIC = 1` (via `performance.now()`).
- **Return Code:** `0` (`ESUCCESS`).

#### `clock_res_get(clock_id: i32, resolution_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `clock_getres`.
- **Signature:** `(clock_id: i32, resolution_out: i32) -> i32`
- **Semantics:** Reports timer resolution (1,000,000 ns for realtime, 1 ns for monotonic). Writes u64 to `resolution_out`.
- **Return Code:** `0` (`ESUCCESS`).

#### `poll_oneoff(in_ptr: i32, out_ptr: i32, nsubscriptions: i32, nevents_out: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `poll`, `select`, `nanosleep`, `sleep`, `usleep`.
- **Signature:** `(in_ptr: i32, out_ptr: i32, nsubscriptions: i32, nevents_out: i32) -> i32`
- **Semantics:** Processes timer subscriptions (`__WASI_EVENTTYPE_CLOCK`). Executes synchronous sleep loop for requested duration and serializes completed events to `out_ptr`. Writes count of events to `nevents_out`.
- **Return Code:** `0` (`ESUCCESS`).

#### `random_get(buf_ptr: i32, buf_len: i32) -> i32`
- **Triggering C / POSIX Mechanism:** `getentropy`, `arc4random_buf`, LLVM random ID generator.
- **Signature:** `(buf_ptr: i32, buf_len: i32) -> i32`
- **Semantics:** Populates buffer at `buf_ptr` with cryptographically secure random bytes via Web Crypto API (`crypto.getRandomValues()`).
- **Return Code:** `0` (`ESUCCESS`).

---

## 5. Host Error Codes (`__wasi_errno_t`)

All WASI functions return an integer status code:

| Constant | Code | Meaning |
|---|---|---|
| `ESUCCESS` | `0` | Success |
| `EBADF` | `8` | Bad file descriptor |
| `EEXIST` | `20` | File or directory already exists |
| `EINVAL` | `28` | Invalid argument or unsupported flag |
| `EISDIR` | `31` | Is a directory |
| `ENOENT` | `44` | No such file or directory |
| `ENOSYS` | `52` | Function not supported / not implemented |
| `ENOTDIR` | `54` | Not a directory |
| `EPERM` | `63` | Operation not permitted |

---

## 6. Implementation Checklist for Host Providers

Any custom host runtime intending to execute `clang-wasi` binaries must satisfy:
1. Provide all 30 functions under `wasi_snapshot_preview1`.
2. Report `st_dev = 1n` (or any non-zero BigInt) in `filestat` calls so Clang does not misidentify distinct directory paths as cyclic loops.
3. Strip `__WASI_RIGHTS_FD_SEEK` and `__WASI_RIGHTS_FD_TELL` from descriptors 0, 1, and 2 so `isatty()` recognizes interactive terminals.
4. Back file reads and writes with an in-memory Virtual File System allowing on-the-fly generation of `.o`, `.a`, and `.wasm` binaries.
5. Provide standard directory preopens: `fd 3` for `.` and `fd 4` for `/`.
