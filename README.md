# clang-wasi

Standalone **Clang**, **Clang++**, and **LLD (wasm-ld)** toolchains compiled to WebAssembly targeting the **WASI Preview 1 (`wasm32-wasip1`)** environment.

Designed as an updated, drop-in compiler backend for in-browser IDEs, sandboxed WebAssembly execution environments, and local WASI runtimes (such as Wasmtime, Wasmer, and `@bjorn3/browser_wasi_shim`).

---

## Features

- **Up-to-date LLVM/Clang:** Built from upstream LLVM 19 releases (`llvmorg-19.1.0`).
- **Target Backend:** Optimized specifically for WebAssembly code generation (`-DLLVM_TARGETS_TO_BUILD="WebAssembly"`).
- **Pure WASI Target:** Cross-compiled with `wasi-sdk` targeting `wasm32-wasip1` without proprietary runtime lock-in.
- **Tuned Runtime Constraints:** Compiled with enlarged 16 MB stack sizes (`-Wl,-z,stack-size=16777216`) to safely support deep C++ template instantiations and AST traversals without tripping runtime stack overflows.
- **Pre-packaged Builtins:** Includes Clang's essential compiler internal headers (`stddef.h`, `stdint.h`, etc.).

---

## Repository Structure

```text
clang-wasi/
├── .github/
│   └── workflows/
│       └── build-release.yml   # Automated release and CI workflow
├── scripts/
│   ├── build.sh                # Main two-stage cross-compilation pipeline
│   ├── test.sh                 # Verification test suite (C & C++)
│   ├── wasi-run.js             # Node.js WASI test runner helper
│   └── patches/
│       └── llvm-wasi-19.1.0.patch # Version-specific WASI compatibility patch
├── src/
│   └── wasi-host.js            # Standalone zero-dependency pure JS WASI Preview 1 host
├── examples/
│   └── wasi-host-run.js        # Standalone in-memory C compilation & execution example
├── dist/                       # Build output artifacts (generated)
│   ├── clang.wasm              # Clang compiler WebAssembly module
│   ├── lld.wasm                # LLD linker WebAssembly module
│   └── sysroot.tar.gz          # Standalone C/C++ sysroot archive
├── AGENTS.md                   # Development rules and platform constraints
└── README.md
```

---

## Prerequisites

Building LLVM from source is memory- and storage-intensive:

* **OS:** Linux (Ubuntu 22.04+ or Debian 12+ recommended)
* **Disk Space:** ~40 GB free space
* **Memory:** 16 GB+ RAM (or 8 GB RAM with at least 16 GB swap)
* **Host Dependencies:**
```bash
sudo apt-get update
sudo apt-get install -y cmake ninja-build clang lld python3 curl tar git binaryen

```



---

## Local Build Instructions

Clone the repository and run the automated build script:

```bash
git clone [https://github.com/](https://github.com/)<your-username>/clang-wasi.git
cd clang-wasi

chmod +x scripts/build.sh
./scripts/build.sh

```

### What `build.sh` Does:

1. Downloads and extracts the matching `wasi-sdk` sysroot and toolchain.
2. Clones the specified LLVM release tag (`llvmorg-19.1.0`) with `--depth 1` and applies WASI platform patches.
3. **Stage 1:** Compiles native host TableGen utilities (`llvm-tblgen`, `clang-tblgen`).
4. **Stage 2:** Cross-compiles `clang` and `lld` using `wasi-sdk-p1.cmake` for `wasm32-wasip1`.
5. Strips and optimizes `clang.wasm` and `lld.wasm` with `wasm-opt -O2`.
6. Assembles the standalone C/C++ sysroot archive (`dist/sysroot.tar.gz`).
7. Packages all components (`clang.wasm`, `lld.wasm`, `sysroot.tar.gz`) into `clang-wasi-19.tar.gz`.

---

## Runtime Usage

Because WASI Preview 1 does not support process spawning (`fork`/`exec`), compilation and linking are split into distinct stages.

### 1. Standalone Verification with Wasmtime

#### Compile C source to an object file:

```bash
wasmtime run \
  --dir=. \
  --dir=/path/to/wasi-sysroot::/sysroot \
  dist/clang.wasm -- \
  --target=wasm32-wasip1 \
  --sysroot=/sysroot \
  -c main.c -o main.o

```

#### Link object file into a runnable WebAssembly executable:

```bash
wasmtime run \
  --dir=. \
  --dir=/path/to/wasi-sysroot::/sysroot \
  --dir=/path/to/wasi-sysroot/lib/wasi::/builtins \
  dist/lld.wasm -- \
  -flavor wasm \
  -L/sysroot/lib/wasm32-wasip1 \
  -L/builtins \
  /sysroot/lib/wasm32-wasip1/crt1.o \
  main.o \
  -lc -lclang_rt.builtins-wasm32 \
  -o main.wasm

```

---

### 2. Recommended: Pure JavaScript WasiHost (Zero-Dependency In-Memory VFS)

This repository includes a standalone, production-ready WASI Preview 1 host in `src/wasi-host.js` that directly bridges `clang.wasm`, `lld.wasm`, and user binaries with an in-memory `Map` or Virtual File System (VFS) without needing `memfs.wasm` or third-party shims:

```javascript
import { WasiHost } from './src/wasi-host.js';

// 1. Prepare in-memory file map
const vfs = new Map();
vfs.set('/workspace', { isDir: true });
vfs.set('/workspace/main.c', new TextEncoder().encode('int main(){ return 0; }'));

// 2. Setup WasiHost for Clang
const clangHost = new WasiHost({
  vfs,
  cwd: '/workspace',
  argv: ['clang', '-cc1', '-triple', 'wasm32-unknown-wasi', '-emit-obj', '-o', '/workspace/main.o', '/workspace/main.c'],
  stdout: str => console.log(str),
  stderr: str => console.error(str),
});

// 3. Instantiate and run
let instance;
clangHost.setMemory(() => instance.exports.memory);
instance = (await WebAssembly.instantiate(clangModule, clangHost.createImportObject())).instance;
instance.exports._start();

// Result is directly accessible in JavaScript VFS:
const objBytes = vfs.get('/workspace/main.o');
```

See `examples/wasi-host-run.js` for a complete runnable example compiling, linking, and executing C code entirely in memory.

---

### 3. Browser Usage with `browser_wasi_shim`

Mount your virtual file tree, provide the sysroot and headers, and invoke the module directly:

```javascript
import { WASI, PreopenDirectory, File } from "@bjorn3/browser_wasi_shim";

// Prepare files inside the in-memory filesystem
const rootDir = new PreopenDirectory("/", new Map([
  ["main.c", new File(new TextEncoder().encode('int main(){ return 0; }'))],
  ["main.o", new File(new Uint8Array(0))]
]));

// Instantiate WASI instance
const wasi = new WASI(
  ["clang", "-cc1", "-emit-obj", "-triple", "wasm32-unknown-wasi", "/main.c", "-o", "/main.o"],
  ["PWD=/"],
  [new OpenFile(new File([])), new OpenFile(new File([])), new OpenFile(new File([])), rootDir]
);

const { instance } = await WebAssembly.instantiateStreaming(
  fetch("clang.wasm"),
  { wasi_snapshot_preview1: wasi.wasiImport }
);

wasi.start(instance);
```

---

## Zero-MemFS Architecture with Pure JavaScript WasiHost

Historically, projects like `binji/wasm-clang` (2019) relied on a compiled `memfs.wasm` module to hold an in-memory POSIX filesystem inside WebAssembly linear memory. That pattern suffered from severe drawbacks:
* **Double-buffering & Memory Duplication**: Every file had to be copied into `memfs.wasm`'s memory before Clang could read it, and copied back out to JavaScript after compilation.
* **ABI & Inode Limitations**: Legacy MemFS suffered from 32-bit `nlink` mismatches, seek whence inversion, hardcoded 1024-inode limits, and unlinking bugs.

This repository eliminates `memfs.wasm` entirely in favor of **`src/wasi-host.js`**:
* **Direct JavaScript Memory**: Files reside directly in standard JavaScript `Map` or `Uint8Array` memory without Wasm linear memory copying.
* **Zero Dependencies**: Standard WASI Preview 1 ABI implementation running out of the box in Node.js and modern browser environments.
* **Dynamic Scale**: File sizes and directories scale naturally with the host JavaScript engine without fixed inode table limits.

---

## Releases & Continuous Integration

Releases are automated via GitHub Actions:

* Pushing a version tag matching `v*` (e.g., `git tag v19.1.0 && git push origin v19.1.0`) triggers `.github/workflows/build-release.yml`.
* The workflow compiles all modules in a clean runner and uploads the release artifacts (`clang.wasm`, `lld.wasm`, `sysroot.tar.gz`, and `clang-wasi-19.tar.gz`) to GitHub Releases.

---

## License

This build automation code is released under the [Apache-2.0 License](https://www.google.com/search?q=LICENSE).
LLVM, Clang, and LLD are licensed under the [Apache 2.0 License with LLVM Exceptions](https://llvm.org/LICENSE.txt).

