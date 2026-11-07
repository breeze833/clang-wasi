# Software Specification: clang-wasi (LLVM/Clang & Pure JavaScript WASI Host Subsystem)

## 1. Project Overview & Objectives

`clang-wasi` provides standalone, zero-backend, WebAssembly-native toolchain binaries for **Clang**, **Clang++**, and **LLD (`wasm-ld`)**, targeting the standard **WASI Snapshot Preview 1 (`wasm32-wasip1`)** environment.

In addition to compiled toolchain binaries, `clang-wasi` provides **`src/wasi-host.js`**, an authoritative, zero-dependency, pure JavaScript WASI Preview 1 runtime host that directly binds WebAssembly instances to in-memory Virtual File Systems (`Map` / `Uint8Array`) without `memfs.wasm` or third-party emulators.

### Key Objectives:
- **Up-to-Date LLVM 19 Toolchain**: Cross-compiled from upstream LLVM releases (`llvmorg-19.1.0`) with `wasi-sdk` targeting `wasm32-wasip1`.
- **Single-Binary Toolchain Consolidation (`llvm-box.wasm`)**:
  - Unifies `clang`, `clang++`, `clang-cpp`, `wasm-ld`, `lld`, `llvm-ar`, `llvm-nm`, `llvm-objdump`, `llvm-size`, `llvm-cxxfilt`, and `llvm-strings` into a single multicall binary (~56 MB optimized via `wasm-opt -O2`).
  - Eliminates redundant downloads and memory footprint of separate compiler and linker binaries.
- **Complete Standalone Sysroot Archive (`sysroot.tar.gz`)**:
  - Bundles standard C headers (`stdio.h`, `stdlib.h`), C++ libc++ headers (`<vector>`, `<iostream>`), compiler-rt builtins (`libclang_rt.builtins.a`), and static runtime libraries (`libc.a`, `libc++.a`, `crt1.o`).
- **Pure JavaScript WASI Preview 1 Host (`wasi-host.js`)**:
  - Authoritative, standalone ES module implementing `wasi_snapshot_preview1` and `wasi_unstable`.
  - Zero double-buffering: WebAssembly read/write syscalls directly interact with JavaScript `Uint8Array` memory without secondary linear memory shims.
  - Universal runtime compatibility: Runs seamlessly in Node.js and browser environments (main thread or Web Worker).
  - Synchronous execution and stream coordination: Supports blocking `Atomics.wait()` stdin for interactive CLI applications and preloaded stream feeding for pipeline chaining.

---

## 2. System Architecture

```
+---------------------------------------------------------------------------------------+
|                                clang-wasi Architecture                                |
|                                                                                       |
|  +---------------------------------------------------------------------------------+  |
|  | Build & Distribution Pipeline                                                   |  |
|  |                                                                                 |  |
|  |   [Upstream LLVM 19.1.0] ──> [POSIX Patches] ──> [Stage 1: Host TableGen]       |  |
|  |                                                         │                       |  |
|  |                                                         v                       |  |
|  |   [wasi-sdk >= 26] ──────────────────────────> [Stage 2: wasi-sdk-p1.cmake]     |  |
|  |                                                         │                       |  |
|  |                                                         v                       |  |
|  |   [llvm-opt -O2] ────────────────────────────> [dist/llvm-box.wasm (56MB)]      |  |
|  |   [wasi-sysroot + clang-headers + builtins] ─> [dist/sysroot.tar.gz]            |  |
|  +---------------------------------------------------------┬────────────────-------+  |
|                                                            │                          |
|                                                            v                          |
|  +---------------------------------------------------------------------------------+  |
|  | Runtime Host Execution Bridge (src/wasi-host.js)                                |  |
|  |                                                                                 |  |
|  |   +───────────────────────────+         +───────────────────────────────────+   |  |
|  |   | WasiHost Engine           |         | In-Memory Virtual File System     |   |  |
|  |   | - Descriptor Table (0..N) |<───────>| - JavaScript Map / Uint8Array     |   |  |
|  |   | - Dynamic Inode Mapping   |         | - Preopened Directories:          |   |  |
|  |   | - Capability Enforcement  |         |   fd 3: '.' (/workspace)          |   |  |
|  |   | - Scatter/Gather I/O      |         |   fd 4: '/' (Sysroot Root)        |   |  |
|  |   +─────────────┬─────────────+         +───────────────────────────────────+   |  |
|  |                 │ imports (wasi_snapshot_preview1)                                  |  |
|  |                 v                                                                   |  |
|  |   +─────────────────────────────────────────────────────────────────────────+   |  |
|  |   | WebAssembly Execution Sandbox                                           |   |  |
|  |   | - Toolchain: llvm-box.wasm (clang, wasm-ld, llvm-ar, llvm-nm, etc.)     |   |  |
|  |   | - User Binaries: a.out / application executables compiled for WASI      |   |  |
|  |   +─────────────────────────────────────────────────────────────────────────+   |  |
|  +---------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------+
```

---

## 3. Toolchain Build & Compilation Specifications

### 3.1 Toolchain Requirements & Threading Invariants

1. **Strictly Single-Threaded WASI Target**:
   - The compiled toolchain targets pure `wasm32-wasip1`.
   - Multithreading **MUST NOT** be enabled: `-DLLVM_ENABLE_THREADS=OFF` must always be supplied during CMake configuration.
   - Target triple MUST NOT be switched to `-threads` variants, and `-pthread` MUST NOT be passed to compile toolchain binaries.
   - Binaries must run out of the box on standard WASI runtimes (Wasmtime, Wasmer, Node.js `wasi`, browser Web Workers) without requiring shared WebAssembly memory.
2. **`wasi-sdk` Toolchain Baseline**:
   - Minimum required version: `wasi-sdk >= 26` (default configured: `wasi-sdk-29.0`).
   - `wasi-sdk >= 26` provides single-threaded dormant pthread mutex support in libc++ (`THREAD_MODEL=single`), allowing standard `<mutex>` and `<shared_mutex>` includes within LLVM headers to compile cleanly without `#define _LIBCPP_HAS_NO_THREADS` compile failures.
   - CMake cross-compilation utilizes `${WASI_SDK_PATH}/share/cmake/wasi-sdk-p1.cmake`.

### 3.2 Platform Emulation & POSIX Patches

WASI Preview 1 does not provide asynchronous POSIX signals, process creation (`fork`/`exec`), file descriptor duplication (`dup2`), file locking (`fcntl`), password databases (`pwd.h`), or BSD sockets.

1. **WASI Compatibility Patch (`scripts/patches/llvm-wasi-${LLVM_VERSION}.patch`)**:
   - Guards unsupported POSIX APIs under `!defined(__wasi__)`.
   - Modifies LLVM support libraries and driver initialization to gracefully bypass signal registrations and child process spawning.
2. **Emulated Library Flags**:
   - Compiler definitions: `-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID`
   - Linker flags: `-lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid`
3. **Execution Stack & Memory Sizing**:
   - Clang's AST traversal and C++ template expansion require significant stack frames:
     `-Wl,--stack-first -Wl,-z,stack-size=16777216 -Wl,--initial-memory=67108864`
   - Configures a dedicated 16 MB stack placed ahead of the data section to detect stack overflows deterministically without memory corruption.

### 3.3 Two-Stage Build Pipeline (`scripts/build.sh`)

1. **Stage 1: Host TableGen Build (`build-native/`)**:
   - Configured with native compiler (`clang` or `gcc`) and `ninja`.
   - Builds host utilities `llvm-tblgen` and `clang-tblgen`.
2. **Stage 2: WASI Cross-Compilation (`build-wasi/`)**:
   - Configured with `wasi-sdk-p1.cmake` toolchain file.
   - Flags:
     - `-DLLVM_HOST_TRIPLE="wasm32-wasip1"`
     - `-DLLVM_TARGETS_TO_BUILD="WebAssembly"`
     - `-DLLVM_ENABLE_PROJECTS="clang;lld"`
     - `-DLLVM_TABLEGEN="$(pwd)/build-native/bin/llvm-tblgen"`
     - `-DCLANG_TABLEGEN="$(pwd)/build-native/bin/clang-tblgen"`
     - `-DLLVM_TOOL_LLVM_DRIVER_BUILD=ON` (compiles unified multicall `llvm-driver`)
     - `-DCMAKE_BUILD_TYPE=MinSizeRel`
   - Compiles target `llvm-driver` producing `build-wasi/bin/llvm`.
3. **Post-Processing & Optimization**:
   - Strips debug bloat and runs Binaryen's `wasm-opt -O2` producing `dist/llvm-box.wasm`.
4. **Sysroot Packaging (`dist/sysroot.tar.gz`)**:
   - Assembles standard sysroot headers from `${WASI_SDK_PATH}/share/wasi-sysroot/include`.
   - Copies built-in Clang headers from `llvm-project/clang/lib/Headers` into `/lib/clang/19/include`.
   - Copies `libclang_rt.builtins.a` for `wasm32-unknown-wasip1`.
   - Creates root-level symlinks (`/include/stdio.h` $\rightarrow$ `wasm32-wasip1/stdio.h`) for classic path resolution compatibility.
   - Archives staging directory into `dist/sysroot.tar.gz`.

---

## 4. Pure JavaScript WASI Preview 1 Host (`WasiHost`)

`src/wasi-host.js` is the canonical, standalone WASI Preview 1 host implementation. It replaces legacy in-Wasm MemFS architectures.

### 4.1 Zero-MemFS Direct Virtual File System Protocol

Historically, WebAssembly compilation tools relied on `memfs.wasm`—an in-memory filesystem compiled to WebAssembly that required:
1. Double-buffering: copy source files from JS $\rightarrow$ `memfs.wasm` linear memory $\rightarrow$ `clang.wasm` linear memory.
2. Rigid 16 MB memory limits and hardcoded 1024-inode tables.
3. Buggy unlinking and offset reuse leading to silent compiler corruptions.

`WasiHost` solves this by directly backing WASI filesystem syscalls with JavaScript memory structures (`Map<string, Uint8Array>` or VFS objects):
- Zero copy-in / copy-out: WASI scatter/gather calls (`fd_read`, `fd_write`) transfer bytes directly between WebAssembly linear memory (`Uint8Array`) and JavaScript memory.
- Dynamic scale: File and directory count scales with available JavaScript heap memory.
- Dynamic Inode Mapping: Maps paths to 64-bit numerical BigInt inodes (`this.inodes.set(path, this.nextInode++)`). Always reports non-zero device identifier (`st_dev = 1n`), preventing Clang from mistaking different header directories as duplicate loops.

### 4.2 Constructor API & Configuration

```javascript
import { WasiHost } from './src/wasi-host.js';

const host = new WasiHost({
  vfs: mapOrVfsObject,            // Map or object containing path -> Uint8Array entries
  cwd: '/workspace',              // Current working directory (default: '/workspace')
  argv: ['clang', '-cc1', ...],   // Command-line arguments
  environ: { USER: 'student' },  // Environment variables
  stdin: null,                    // Interactive stdin reader function or Uint8Array buffer
  stdout: (text) => {},           // Standard output callback
  stderr: (text) => {},           // Standard error callback
  getMemory: () => instance.exports.memory, // Memory getter function
  preopens: [                     // Capability directory descriptors
    { fd: 3, path: '/workspace', name: '.' },
    { fd: 4, path: '/',          name: '/' },
  ],
  onFileSync: (path, bytes) => {}, // Callback when file is written or flushed
  onFileDelete: (path) => {},     // Callback when file is unlinked
});
```

### 4.3 Preopened Directory Resolution

`WasiHost` enforces capability-based directory access per WASI specification:
- Descriptor 3 (`.`): Defaults to `this.cwd` (e.g. `/workspace`).
- Descriptor 4 (`/`): Defaults to `/` (sysroot root).
- Relative paths passed to `path_open(dirfd, pathStr, ...)` resolve against the base path corresponding to `dirfd`.
- Normalization: Path segments (`.`, `..`, redundant slashes) are cleanly resolved via `normalizePath()`.

### 4.4 Comprehensive WASI Preview 1 Syscall Specifications

`WasiHost` provides complete implementations under the `wasi_snapshot_preview1` and `wasi_unstable` namespaces:

| Syscall | WASI Code | Specification & Behavior |
|---|---|---|
| `path_open` | 0 | Resolves `dirfd` and relative path; checks flags (`O_CREAT`, `O_TRUNC`, `O_EXCL`, `O_DIRECTORY`) and append mode (`FDFLAG_APPEND`); allocates `fd >= 10`. |
| `fd_read` / `fd_pread` | 0 | Scatter/gather reads across `iovec` structs. For `fd 0`, delegates to `stdin` handler (synchronous `Atomics.wait` or preloaded stream). For regular files, copies from VFS buffer into Wasm memory. |
| `fd_write` / `fd_pwrite` | 0 | Scatter/gather writes across `ciovec` structs. For `fd 1` / `fd 2`, decodes UTF-8 and routes to `stdout` / `stderr`. For regular files, expands buffer and triggers `onFileSync`. |
| `fd_seek` | 0 | Adjusts descriptor byte offset (`SEEK_SET = 0`, `SEEK_CUR = 1`, `SEEK_END = 2`). |
| `fd_tell` | 0 | Returns current byte offset for descriptor. |
| `fd_close` | 0 | Deallocates descriptor table entry. |
| `fd_filestat_get` | 0 | Writes 64-byte `__wasi_filestat_t` layout (`dev=1n`, `ino`, `filetype`, `nlink=1`, `size` at offset 32, timestamps). |
| `fd_filestat_set_size` | 0 | Truncates or extends descriptor file buffer. |
| `path_filestat_get` | 0 | Queries file metadata directly by path without opening. |
| `path_filestat_set_times` | 0 | Updates access and modification timestamps. |
| `fd_readdir` | 0 | Serializes standard 24-byte `__wasi_dirent_t` headers with deterministic cookie sequence. |
| `path_create_directory` | 0 | Creates directory entry in VFS. |
| `path_unlink_file` | 0 | Removes file from VFS and triggers `onFileDelete`. |
| `path_remove_directory` | 0 | Removes empty directory entry from VFS. |
| `path_rename` | 0 | Atomically updates path in VFS. |
| `fd_prestat_get` | 0 | Advertises preopened directory descriptor type (`__WASI_PREOPENTYPE_DIR = 0`). |
| `fd_prestat_dir_name` | 0 | Writes preopened directory name (e.g. `.` or `/`) into Wasm buffer. |
| `environ_sizes_get` | 0 | Reports count and total byte length of environment strings. |
| `environ_get` | 0 | Writes environment string pointers and null-terminated strings (`KEY=VALUE\0`). |
| `args_sizes_get` | 0 | Reports argument count and total string buffer size. |
| `args_get` | 0 | Writes `argv` pointers and null-terminated strings. |
| `clock_time_get` | 0 | High-resolution clock (`CLOCKID_MONOTONIC = 1`, `CLOCKID_REALTIME = 0`). |
| `clock_res_get` | 0 | Reports 1ns clock resolution. |
| `poll_oneoff` | 0 | Supports non-blocking and timeout polling (sleep) using high-precision timers. |
| `random_get` | 0 | Populates random byte buffer via Web Crypto API `crypto.getRandomValues()`. |
| `proc_exit` | - | Throws `ProcExit(code, changedFiles, deletedFiles)` caught by execution wrapper. |

### 4.5 Execution Wrapper & Lifecycle

`WasiHost.prototype.createImportObject()` returns the host imports required for `WebAssembly.instantiate`:
```javascript
const imports = wasiHost.createImportObject();
// imports['wasi_snapshot_preview1'] contains all syscall functions
// imports['wasi_unstable'] contains alias bindings
```

Execution handles exit codes cleanly via `ProcExit`:
```javascript
try {
  instance.exports._start();
  return 0;
} catch (err) {
  if (err instanceof ProcExit) {
    return err.code;
  }
  throw err;
}
```

### 4.6 Pure WASI Preview 1 Invariant & Decoupling of Shell Hooks

`clang-wasi` (`llvm-box.wasm` multicall driver and user executables compiled for WASI Preview 1) operates strictly over pure WASI Preview 1 (`wasi_snapshot_preview1` / `wasi_unstable`) and direct VFS file operations:
1. **Toolchain Purity**: The compiler toolchain requires zero custom host functions beyond standard WASI Preview 1. It imports exactly 30 standard syscall functions from `wasi_snapshot_preview1`.
2. **Decoupling of Foreign Shell Hooks**: Interactive shell hooks (`__host_pipe`, `__host_dup`, `__host_dup2`, `__host_winsize`, `__host_winch`, `__host_interrupt`, `__host_sock_*`, `__host_builtin_*`, `wasi_host_spawn`) which originated in foreign BusyBox shell environments are decoupled and removed from `src/wasi-host.js`.
3. **Reference Host & Component Provider Contract**:
   - `docs/HOST_FUNCTIONS.md` is the authoritative technical specification for host function signatures, memory layouts (`__wasi_ciovec_t`, `__wasi_iovec_t`, `__wasi_filestat_t`, `__wasi_fdstat_t`, `__wasi_dirent_t`, `__wasi_prestat_t`), and error codes.
   - `examples/host-reference.js` provides a zero-dependency, production-grade reference runner implementing 100% of the contract and providing integrated self-verification (`npm test` / `node examples/host-reference.js`).
   - If downstream integrators (such as `wasm-c-ide` or interactive shells) require custom `env` bindings, `WasiHost.prototype.createImportObject(customEnv)` accepts custom extensions with permissive fallback proxies.

---

## 5. Verification & Testing Standards

To maintain compatibility with upstream LLVM, WASI Preview 1, and downstream consumers (such as `wasm-c-ide`), all modifications must pass the test suite:

1. **Standalone Host Reference Self-Verification (`node examples/host-reference.js`)**:
   - Validates in-memory sysroot extraction via `createVfsFromSysroot`.
   - Validates C compilation, linking, and execution.
   - Validates C++ template compilation and standard library linking.
   - Validates multicall tool execution (`llvm-cxxfilt`).
2. **Automated WasiHost Test Suite (`node scripts/test-wasi-host.js`)**:
   - Validates in-memory C compilation with `dist/llvm-box.wasm`.
   - Validates in-memory object linking with `wasm-ld`.
   - Validates C++ template compilation and standard library linking.
   - Validates scatter/gather file I/O, file creation, truncation, and directory enumeration.
   - Validates UTF-8 decoding and high-precision `poll_oneoff` timer delay.
3. **Unified Verification Suite (`npm test`)**:
   ```bash
   npm test
   ```
   Must complete with zero errors and exit code 0.
