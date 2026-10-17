# Agent Development and Build Guidelines

This repository compiles LLVM, Clang, and LLD to WebAssembly targeting the **WASI Preview 1 (`wasm32-wasip1`)** environment.

When developing, debugging, or building this project, autonomous agents must adhere to the following rules and technical constraints:

---

## 1. Threading Model and Constraints

* **Strictly Single-Threaded:** Target execution is pure WASI Preview 1 (`wasm32-wasip1`). Multithreading **MUST NOT** be enabled:
  `-DLLVM_ENABLE_THREADS=OFF` must always be passed during cross-compilation.
* **No `wasm32-wasi-threads`:** Do not switch target triples to `-threads` variants or pass `-pthread` unless explicitly requested by the user. The intended distribution must run on standard single-threaded WASI runtimes (such as `@bjorn3/browser_wasi_shim` in browsers, Wasmer, and standard Wasmtime) without requiring shared memory or web worker threading.

---

## 2. Toolchain Requirements (`wasi-sdk`)

* **Minimum `wasi-sdk` Version:** `wasi-sdk >= 26` (default configured: `29.0`).
  * Older versions (such as `wasi-sdk-24.0`) hardcoded `#define _LIBCPP_HAS_NO_THREADS` in single-threaded libc++, causing `<mutex>` and `<shared_mutex>` header inclusions in LLVM headers to fail compilation.
  * In `wasi-sdk >= 26`, libc++ includes single-threaded dormant pthread mutex support for `THREAD_MODEL=single`, enabling `<mutex>` usage cleanly in single-threaded builds.
  * `wasi-sdk >= 25` also provides the modern CMake toolchain file `${WASI_SDK_PATH}/share/cmake/wasi-sdk-p1.cmake`.

---

## 3. Platform Emulation and POSIX Patches

* **POSIX Patches (`scripts/patches/llvm-wasi-${LLVM_VERSION}.patch`):** WASI Preview 1 lacks asynchronous signals, process creation (`fork`/`exec`), `dup2`, file locking (`fcntl`), password databases (`pwd.h`), and BSD sockets.
  * The patch conditionalizes these unsupported features under `!defined(__wasi__)`.
  * Ensure the version-specific patch (`scripts/patches/llvm-wasi-${LLVM_VERSION}.patch`) remains synchronized with any manual adjustments made to `llvm-project`.
* **Emulated Library Flags:** CMake cross-compilation requires the following emulation flags and libraries:
  * Compiler definitions: `-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID`
  * Linker flags: `-lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid`

---

## 4. Build Structure & Release Packaging

The build pipeline consists of two stages followed by community-compatible packaging:
1. **Stage 1 (Host Build):** Compiles host utilities `llvm-tblgen` and `clang-tblgen` natively inside `build-native/`.
2. **Stage 2 (WASI Cross-compilation):** Cross-compiles `clang` and `lld` using `wasi-sdk-p1.cmake` inside `build-wasi/`.
3. **Packaging (`dist/`):** Outputs the canonical 4-component community toolchain:
   - `clang.wasm`: Clang compiler optimized via `wasm-opt -O2`.
   - `lld.wasm`: LLD linker optimized via `wasm-opt -O2`.
   - `memfs.wasm`: WASI in-memory filesystem module compiled natively from `src/memfs/` via `wasi-sdk` and optimized via `wasm-opt -O3`.
   - `sysroot.tar`: Complete standalone sysroot archive containing standard C/C++ headers (`stdio.h`, `<vector>`), static libraries (`libc.a`, `libc++.a`, `crt1.o`), and Clang runtime builtins (`libclang_rt.builtins.a`).
4. **Distribution Archive (`clang-wasi-19.tar.gz`):** Bundles all four artifacts above into a compressed release tarball.

---

## 5. Resumability and Patch Detection

* **Resumable Execution:** `scripts/build.sh` must be safe to interrupt and re-run at any point without redoing completed steps or leaving corrupted intermediate artifacts.
* **Patch Detection:** Always verify whether `scripts/patches/llvm-wasi-${LLVM_VERSION}.patch` is already applied using `git -C llvm-project apply --reverse --check "${PATCH_FILE}"`. If reverse check passes, skip patching. If forward check passes, apply it. If both fail, fail with an error rather than ignoring failures with `|| true`.
* **Atomic Processing:** Always write to temporary paths (`.tmp`, `.opt`) before moving to the final output file to prevent corrupt binaries if interrupted mid-process.
* **Incremental Steps:** Avoid running time-consuming optimization passes (`wasm-opt`) or tarball archiving if the source binaries have not changed (`[ "${src}" -nt "${dest}" ]`).

---

## 6. Native MemFS Architecture & LLVM 19 Compatibility

`dist/memfs.wasm` must be built directly from `src/memfs/` (`memfs.c`, `stb_sprintf.h`) using `${WASI_SDK_PATH}/bin/clang` and `wasm-ld`, replacing the legacy prebuilt binary from `binji/wasm-clang`.

Testing revealed four specific ABI and structural mismatches between the 2019 `binji/wasm-clang` binary and modern LLVM 19:

1. **`__wasi_filestat_t` Struct Offset Mismatch:**
   * The 2019 `memfs.wasm` was built against an early `wasi_unstable` ABI where `nlink` was 32-bit (`uint32_t`), placing `size` at byte offset 24.
   * Modern LLVM 19 (`wasi_snapshot_preview1`) follows the standard WASI specification with 64-bit `nlink` (`__wasi_linkcount_t`), placing `size` at byte offset 32.
   * **Consequence:** Clang 19 reads `size = 0` for all files mounted in MemFS, failing with: `error: ISO C requires a translation unit to contain at least one declaration [-Wempty-translation-unit]`.
2. **`fd_seek` Whence Enum Inversion:**
   * The 2019 `memfs.wasm` used internal constants: `0 = CUR`, `1 = END`, `2 = SET`.
   * Standard WASI Preview 1 specifies: `0 = SET`, `1 = CUR`, `2 = END`.
   * **Consequence:** When Clang seeks back to patch WebAssembly section lengths, MemFS treats absolute seek 0 as relative seek CUR, corrupting the emitted object file with zero-length sections.
3. **Hardcoded Inode Table Limit (`MAX_NODES = 1024`):**
   * The 2019 `memfs.wasm` allocated a static array `nodes[1024]`.
   * Upstream LLVM 19 `sysroot.tar` contains 4,512 entries (full C++ standard library headers, runtime libraries, and multiple target triples).
   * **Consequence:** Eagerly unpacking `sysroot.tar` on boot crashes with `RuntimeError: unreachable` at entry 1076 (`inode != INVALID_INODE`). Native `src/memfs/memfs.c` provides dynamic inode table reallocation without a hard 1024 limit.
4. **Inode Reallocation Offset Bug on Unlink:**
   * `path_unlink_file` in the 2019 `memfs.wasm` does not reset the buffer write offset on reused inodes.
   * **Consequence:** Re-creating a file after unlinking retains stale write offsets, requiring clumsy truncate-before-unlink workarounds. Native MemFS completely resets inode buffers and file descriptor offsets on deletion and reuse.
