#!/usr/bin/env node
/**
 * Standalone example demonstrating how to compile, link, and execute C/C++
 * programs using LLVM 19 WASI binaries and WasiHost with an in-memory VFS Map.
 *
 * Requirements:
 *   - Node.js (>= 18)
 *   - Release assets in dist/ (llvm-box.wasm, sysroot.tar.gz)
 *
 * Usage:
 *   node examples/wasi-host-run.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WasiHost, ProcExit } = require('../src/wasi-host.js');

// Simple Tar reader for sysroot.tar.gz
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

async function runWasm(module, wasiHost) {
  let instance;
  wasiHost.setMemory(() => instance?.exports?.memory);
  instance = await WebAssembly.instantiate(module, wasiHost.createImportObject());
  try {
    if (typeof instance.exports._start === 'function') {
      instance.exports._start();
    }
    return 0;
  } catch (err) {
    if (err instanceof ProcExit) return err.code;
    throw err;
  }
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');

  console.log('--- WasiHost Pure JavaScript WASI Preview 1 Runner ---');

  // 1. In-memory VFS Map
  const vfs = new Map();
  vfs.set('/workspace', { isDir: true });
  vfs.set('/', { isDir: true });

  // 2. Unpack sysroot.tar.gz into VFS
  console.log('Unpacking sysroot.tar.gz into in-memory VFS...');
  const tarBuf = zlib.gunzipSync(fs.readFileSync(path.join(distDir, 'sysroot.tar.gz')));
  const entries = new SimpleTar(tarBuf).getEntries();
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

  // 3. Populate sample C code
  const sourceCode = `#include <stdio.h>

int main(void) {
    printf("Hello from WebAssembly in-memory C program!\\n");
    for (int i = 1; i <= 3; i++) {
        printf("  Step %d: execution running via WasiHost\\n", i);
    }
    return 0;
}
`;
  vfs.set('/workspace/main.c', Buffer.from(sourceCode));
  console.log('Created /workspace/main.c in VFS.');

  // 4. Compile and link with llvm-box.wasm
  console.log('Loading llvm-box.wasm...');
  const llvmBoxModule = await WebAssembly.compile(fs.readFileSync(path.join(distDir, 'llvm-box.wasm')));

  console.log('Compiling main.c with llvm-box (clang)...');
  const clangHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: [
      'clang', '-cc1', '-triple', 'wasm32-unknown-wasi', '-emit-obj',
      '-isysroot', '/',
      '-internal-isystem', '/include',
      '-internal-isystem', '/include/wasm32-wasip1',
      '-internal-isystem', '/usr/include',
      '-internal-isystem', '/lib/clang/19/include',
      '-O2', '-x', 'c', '-std=c11',
      '-o', '/workspace/main.o', '/workspace/main.c',
    ],
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  });
  const clangExit = await runWasm(llvmBoxModule, clangHost);
  if (clangExit !== 0) throw new Error(`Compilation failed with code ${clangExit}`);
  console.log('[+] Generated /workspace/main.o');

  // 5. Link with llvm-box (wasm-ld)
  console.log('Linking main.o with llvm-box (wasm-ld)...');
  const lldHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: [
      'wasm-ld', '-flavor', 'wasm',
      '-z', 'stack-size=1048576',
      '-L/lib/wasm32-wasip1',
      '-L/lib/clang/19/lib/wasm32-unknown-wasip1',
      '/lib/wasm32-wasip1/crt1.o',
      '/workspace/main.o',
      '-lc', '-lclang_rt.builtins',
      '-o', '/workspace/main.wasm',
    ],
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  });
  const lldExit = await runWasm(llvmBoxModule, lldHost);
  if (lldExit !== 0) throw new Error(`Linking failed with code ${lldExit}`);
  console.log('[+] Generated /workspace/main.wasm');

  // 6. Execute binary with WasiHost
  console.log('\n--- Executing /workspace/main.wasm ---');
  const binaryBytes = vfs.get('/workspace/main.wasm');
  const binModule = await WebAssembly.compile(binaryBytes);
  const runHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['main.wasm'],
    preopens: [{ fd: 3, path: '/workspace', name: '.' }],
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  });
  const exitCode = await runWasm(binModule, runHost);
  console.log(`--- Program finished with exit code ${exitCode} ---`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
