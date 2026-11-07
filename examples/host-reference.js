#!/usr/bin/env node
/**
 * Standalone Reference WASI Host & Toolchain Runner (examples/host-reference.js)
 *
 * Implements 100% of the host contract defined in docs/HOST_FUNCTIONS.md:
 * - Pure WASI Preview 1 (wasi_snapshot_preview1) system call execution
 * - Zero double-buffering direct VFS (Map / Uint8Array)
 * - Self-contained runner and compiler driver for llvm-box.wasm and compiled binaries
 * - Zero external dependencies (standard Node.js builtins: fs, path, zlib, assert)
 *
 * Usage:
 *   node examples/host-reference.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { WasiHost, ProcExit, normalizePath, ESUCCESS } = require('../src/wasi-host.js');

/**
 * Minimal in-memory Tar extractor for sysroot.tar.gz
 */
class SimpleTar {
  constructor(buffer) {
    this.u8 = new Uint8Array(buffer);
    this.offset = 0;
  }

  readStr(len) {
    let s = '';
    const end = this.offset + len;
    for (let i = this.offset; i < end && this.u8[i] !== 0; i++) {
      s += String.fromCharCode(this.u8[i]);
    }
    this.offset += len;
    return s;
  }

  readOctal(len) {
    const s = this.readStr(len).trim();
    return s.length > 0 ? parseInt(s, 8) : 0;
  }

  getEntries() {
    const entries = [];
    while (this.offset + 512 <= this.u8.length) {
      const start = this.offset;
      const filename = this.readStr(100);
      if (!filename) break;
      this.offset = start + 124;
      const size = this.readOctal(12);
      this.offset = start + 156;
      const type = this.readStr(1);
      const linkname = this.readStr(100);
      this.offset = start + 512;

      const entry = { filename, linkname, size, type: type || '0' };
      if (entry.type === '0' || entry.type === '') {
        entry.contents = this.u8.slice(this.offset, this.offset + entry.size);
        this.offset += entry.size;
        this.offset = (this.offset + 511) & ~511;
      } else {
        this.offset = (this.offset + 511) & ~511;
      }
      entries.push(entry);
    }
    return entries;
  }
}

/**
 * Creates an in-memory VFS Map populated with unpacked sysroot files.
 * @param {Uint8Array|Buffer} tarGzBuffer
 * @returns {Map<string, Uint8Array|{isDir: boolean}>}
 */
function createVfsFromSysroot(tarGzBuffer) {
  const vfs = new Map();
  vfs.set('/', { isDir: true });
  vfs.set('/workspace', { isDir: true });

  const decompressed = zlib.gunzipSync(tarGzBuffer);
  const tar = new SimpleTar(decompressed);
  const entries = tar.getEntries();

  for (const entry of entries) {
    const clean = entry.filename.replace(/^\.?\/+/, '');
    if (!clean) continue;
    const vfsPath = '/' + clean;
    if (entry.type === '5') {
      vfs.set(vfsPath, { isDir: true });
    } else if (entry.contents) {
      vfs.set(vfsPath, entry.contents);
    }
  }

  return vfs;
}

/**
 * Instantiates and executes a WebAssembly instance with WasiHost.
 * @param {WebAssembly.Module|Uint8Array} wasmSource
 * @param {WasiHost} wasiHost
 * @returns {Promise<number>} exit code
 */
async function runWasm(wasmSource, wasiHost) {
  const module = wasmSource instanceof WebAssembly.Module ? wasmSource : await WebAssembly.compile(wasmSource);
  let instance;
  wasiHost.setMemory(() => instance?.exports?.memory);
  instance = await WebAssembly.instantiate(module, wasiHost.createImportObject());

  try {
    if (typeof instance.exports._start === 'function') {
      instance.exports._start();
    }
    return 0;
  } catch (err) {
    if (err instanceof ProcExit) {
      return err.code;
    }
    throw err;
  }
}

/**
 * Compiles a C source file to an object file in VFS using llvm-box.wasm.
 */
async function compileC({ llvmBoxModule, vfs, sourcePath, objectPath, std = 'c11', optLevel = '-O2' }) {
  let output = '';
  const clangHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: [
      'clang',
      '-cc1',
      '-triple', 'wasm32-unknown-wasi',
      '-emit-obj',
      '-disable-free',
      '-isysroot', '/',
      '-internal-isystem', '/include',
      '-internal-isystem', '/include/wasm32-wasip1',
      '-internal-isystem', '/usr/include',
      '-internal-isystem', '/lib/clang/19/include',
      optLevel,
      '-x', 'c',
      `-std=${std}`,
      '-o', objectPath,
      sourcePath,
    ],
    stdout: s => { output += s; },
    stderr: s => { output += s; },
  });

  const exitCode = await runWasm(llvmBoxModule, clangHost);
  if (exitCode !== 0 || !vfs.has(objectPath)) {
    throw new Error(`C compilation failed (code ${exitCode}):\n${output}`);
  }
  return exitCode;
}

/**
 * Compiles a C++ source file to an object file in VFS using llvm-box.wasm.
 */
async function compileCpp({ llvmBoxModule, vfs, sourcePath, objectPath, std = 'c++17', optLevel = '-O2' }) {
  let output = '';
  const clangHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: [
      'clang',
      '-cc1',
      '-triple', 'wasm32-unknown-wasi',
      '-emit-obj',
      '-disable-free',
      '-isysroot', '/',
      '-internal-isystem', '/include/wasm32-wasip1/c++/v1',
      '-internal-isystem', '/include/c++/v1',
      '-internal-isystem', '/include',
      '-internal-isystem', '/include/wasm32-wasip1',
      '-internal-isystem', '/usr/include',
      '-internal-isystem', '/lib/clang/19/include',
      optLevel,
      '-x', 'c++',
      `-std=${std}`,
      '-o', objectPath,
      sourcePath,
    ],
    stdout: s => { output += s; },
    stderr: s => { output += s; },
  });

  const exitCode = await runWasm(llvmBoxModule, clangHost);
  if (exitCode !== 0 || !vfs.has(objectPath)) {
    throw new Error(`C++ compilation failed (code ${exitCode}):\n${output}`);
  }
  return exitCode;
}

/**
 * Links object files into a standalone WebAssembly executable (.wasm) in VFS.
 */
async function linkWasm({ llvmBoxModule, vfs, objectPaths, outputPath, isCpp = false }) {
  let output = '';
  const lldArgs = [
    'wasm-ld',
    '-flavor', 'wasm',
    '-z', 'stack-size=1048576',
    '-L/lib/wasm32-wasip1',
    '-L/lib/clang/19/lib/wasm32-unknown-wasip1',
    '/lib/wasm32-wasip1/crt1.o',
    ...objectPaths,
  ];

  if (isCpp) {
    lldArgs.push('-lc++', '-lc++abi');
  }
  lldArgs.push('-lc', '-lclang_rt.builtins', '-o', outputPath);

  const lldHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: lldArgs,
    stdout: s => { output += s; },
    stderr: s => { output += s; },
  });

  const exitCode = await runWasm(llvmBoxModule, lldHost);
  if (exitCode !== 0 || !vfs.has(outputPath)) {
    throw new Error(`Linking failed (code ${exitCode}):\n${output}`);
  }
  return exitCode;
}

/**
 * Integrated self-verification test suite
 */
async function runSelfTests() {
  console.log('===========================================================');
  console.log('   Standalone Host Reference Runner: Self-Verification     ');
  console.log('===========================================================');

  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const wasmPath = path.join(distDir, 'llvm-box.wasm');
  const sysrootPath = path.join(distDir, 'sysroot.tar.gz');

  assert.ok(fs.existsSync(wasmPath), `llvm-box.wasm missing at ${wasmPath}`);
  assert.ok(fs.existsSync(sysrootPath), `sysroot.tar.gz missing at ${sysrootPath}`);

  // 1. Unpack sysroot into VFS
  console.log('[1/5] Unpacking sysroot into in-memory VFS Map...');
  const vfs = createVfsFromSysroot(fs.readFileSync(sysrootPath));
  assert.ok(vfs.size > 1000, `Sysroot entries count unexpected: ${vfs.size}`);
  console.log(`[+] Sysroot initialized with ${vfs.size} VFS entries.`);

  // 2. Compile llvm-box.wasm module
  console.log('[2/5] Compiling llvm-box.wasm module...');
  const llvmBoxModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
  console.log('[+] llvm-box.wasm compiled successfully.');

  // 3. Test C Compilation, Linking, and Execution
  console.log('[3/5] Testing C compilation, linking, and execution...');
  const cSource = `#include <stdio.h>
int main(void) {
    printf("Hello from host-reference C!\\n");
    return 0;
}
`;
  vfs.set('/workspace/test_c.c', Buffer.from(cSource));

  await compileC({
    llvmBoxModule,
    vfs,
    sourcePath: '/workspace/test_c.c',
    objectPath: '/workspace/test_c.o',
  });
  assert.ok(vfs.has('/workspace/test_c.o'));

  await linkWasm({
    llvmBoxModule,
    vfs,
    objectPaths: ['/workspace/test_c.o'],
    outputPath: '/workspace/test_c.wasm',
    isCpp: false,
  });
  assert.ok(vfs.has('/workspace/test_c.wasm'));

  let cStdout = '';
  const cRunHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['test_c.wasm'],
    preopens: [{ fd: 3, path: '/workspace', name: '.' }],
    stdout: s => { cStdout += s; },
  });
  const cExitCode = await runWasm(vfs.get('/workspace/test_c.wasm'), cRunHost);
  assert.strictEqual(cExitCode, 0, `Expected exit code 0, got ${cExitCode}`);
  assert.strictEqual(cStdout.trim(), 'Hello from host-reference C!');
  console.log('[+] C test passed: output verified.');

  // 4. Test C++ Compilation, Linking, and Execution
  console.log('[4/5] Testing C++ compilation, linking, and execution...');
  const cppSource = `#include <iostream>
#include <vector>
#include <string>

int main() {
    std::vector<std::string> parts = {"host-reference", "pure", "JS", "C++"};
    for (size_t i = 0; i < parts.size(); ++i) {
        std::cout << parts[i] << (i + 1 < parts.size() ? " " : "\\n");
    }
    return 0;
}
`;
  vfs.set('/workspace/test_cpp.cpp', Buffer.from(cppSource));

  await compileCpp({
    llvmBoxModule,
    vfs,
    sourcePath: '/workspace/test_cpp.cpp',
    objectPath: '/workspace/test_cpp.o',
  });
  assert.ok(vfs.has('/workspace/test_cpp.o'));

  await linkWasm({
    llvmBoxModule,
    vfs,
    objectPaths: ['/workspace/test_cpp.o'],
    outputPath: '/workspace/test_cpp.wasm',
    isCpp: true,
  });
  assert.ok(vfs.has('/workspace/test_cpp.wasm'));

  let cppStdout = '';
  const cppRunHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['test_cpp.wasm'],
    preopens: [{ fd: 3, path: '/workspace', name: '.' }],
    stdout: s => { cppStdout += s; },
  });
  const cppExitCode = await runWasm(vfs.get('/workspace/test_cpp.wasm'), cppRunHost);
  assert.strictEqual(cppExitCode, 0, `Expected exit code 0, got ${cppExitCode}`);
  assert.strictEqual(cppStdout.trim(), 'host-reference pure JS C++');
  console.log('[+] C++ test passed: output verified.');

  // 5. Test Multicall utilities (llvm-cxxfilt)
  console.log('[5/5] Testing llvm-box multicall utility (llvm-cxxfilt)...');
  let filtStdout = '';
  const filtHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['llvm-cxxfilt', '_Z3addii'],
    stdout: s => { filtStdout += s; },
  });
  const filtExit = await runWasm(llvmBoxModule, filtHost);
  assert.strictEqual(filtExit, 0);
  assert.ok(filtStdout.includes('add(int, int)'), `Demangling failed: ${filtStdout}`);
  console.log('[+] Multicall utility verified: _Z3addii -> add(int, int)');

  console.log('===========================================================');
  console.log('   All host-reference self-tests PASSED successfully!      ');
  console.log('===========================================================');
  return true;
}

// Module exports for external integrators (e.g. wasm-c-ide)
module.exports = {
  WasiHost,
  ProcExit,
  normalizePath,
  SimpleTar,
  createVfsFromSysroot,
  runWasm,
  compileC,
  compileCpp,
  linkWasm,
  runSelfTests,
};

// Direct CLI invocation self-verification
if (require.main === module) {
  runSelfTests().catch(err => {
    console.error('[-] Self-test error:', err);
    process.exit(1);
  });
}
