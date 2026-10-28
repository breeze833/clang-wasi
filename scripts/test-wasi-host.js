#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WasiHost, ProcExit } = require('../src/wasi-host.js');

function readStr(u8, offset, len = -1) {
  let str = '';
  const end = len !== -1 ? offset + len : u8.length;
  for (let i = offset; i < end && u8[i] !== 0; ++i) {
    str += String.fromCharCode(u8[i]);
  }
  return str;
}

class TarReader {
  constructor(buffer) {
    this.u8 = new Uint8Array(buffer);
    this.offset = 0;
  }

  readStr(len) {
    const s = readStr(this.u8, this.offset, len);
    this.offset += len;
    return s;
  }

  readOctal(len) {
    const s = this.readStr(len).trim();
    return s.length > 0 ? parseInt(s, 8) : 0;
  }

  alignUp() {
    this.offset = (this.offset + 511) & ~511;
  }

  getEntries() {
    const entries = [];
    while (this.offset + 512 <= this.u8.length) {
      const start = this.offset;
      const filename = this.readStr(100);
      if (!filename) break;
      this.readOctal(8);
      this.readOctal(8);
      this.readOctal(8);
      const size = this.readOctal(12);
      this.readOctal(12);
      this.readOctal(8);
      const type = this.readStr(1);
      const linkname = this.readStr(100);
      this.offset = start + 512;

      const entry = {
        filename,
        linkname,
        size,
        type: type || '0',
      };

      if (entry.type === '0' || entry.type === '') {
        entry.contents = this.u8.slice(this.offset, this.offset + entry.size);
        this.offset += entry.size;
        this.alignUp();
      } else {
        this.alignUp();
      }
      entries.push(entry);
    }
    return entries;
  }
}

async function runInstance(wasmModule, wasiHost) {
  let instance;
  wasiHost.setMemory(() => instance?.exports?.memory);
  const imports = wasiHost.createImportObject();
  instance = await WebAssembly.instantiate(wasmModule, imports);

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

async function main() {
  console.log('======================================================');
  console.log('   WasiHost Standalone In-Memory VFS Test Suite       ');
  console.log('======================================================');

  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const clangWasmPath = path.join(distDir, 'clang.wasm');
  const lldWasmPath = path.join(distDir, 'lld.wasm');
  const llvmBoxWasmPath = path.join(distDir, 'llvm-box.wasm');
  const sysrootGzPath = path.join(distDir, 'sysroot.tar.gz');

  if (!fs.existsSync(clangWasmPath) || !fs.existsSync(lldWasmPath) || !fs.existsSync(llvmBoxWasmPath) || !fs.existsSync(sysrootGzPath)) {
    console.error('Error: Missing required dist files (clang.wasm, lld.wasm, llvm-box.wasm, sysroot.tar.gz).');
    process.exit(1);
  }

  // 1. Unpack sysroot into in-memory VFS Map
  console.log('1. Loading sysroot into in-memory VFS Map...');
  const vfs = new Map();

  vfs.set('/workspace', { isDir: true, mtime: Date.now() });
  vfs.set('/', { isDir: true, mtime: Date.now() });

  const gzBuf = fs.readFileSync(sysrootGzPath);
  const tarBuf = zlib.gunzipSync(gzBuf);
  const reader = new TarReader(tarBuf);
  const entries = reader.getEntries();

  for (const entry of entries) {
    const clean = entry.filename.replace(/^\.?\/+/, '');
    if (!clean) continue;
    const vfsPath = '/' + clean;

    if (entry.type === '5') {
      vfs.set(vfsPath, { isDir: true, mtime: Date.now() });
    } else if (entry.contents) {
      vfs.set(vfsPath, {
        isDir: false,
        data: entry.contents,
        mtime: Date.now(),
      });
    }
  }

  // Symlinks
  for (const entry of entries) {
    if (entry.type === '2' && entry.linkname) {
      const clean = entry.filename.replace(/^\.?\/+/, '');
      if (!clean) continue;
      const vfsPath = '/' + clean;
      const lastSlash = clean.lastIndexOf('/');
      const parentDir = lastSlash !== -1 ? clean.substring(0, lastSlash) : '';
      let targetPath = entry.linkname.replace(/^\.?\/+/, '');
      if (parentDir && !entry.linkname.startsWith('/')) {
        targetPath = `${parentDir}/${targetPath}`;
      }
      const cleanTarget = '/' + targetPath.replace(/^\/+/, '');
      const targetObj = vfs.get(cleanTarget);
      if (targetObj) {
        vfs.set(vfsPath, { ...targetObj });
      }
    }
  }

  console.log(`[+] Sysroot loaded: ${vfs.size} VFS entries.`);

  // 2. Compile modules
  console.log('2. Compiling clang.wasm and lld.wasm WebAssembly modules...');
  const clangModule = await WebAssembly.compile(fs.readFileSync(clangWasmPath));
  const lldModule = await WebAssembly.compile(fs.readFileSync(lldWasmPath));
  console.log('[+] Modules compiled.');

  // 3. Test C compilation and execution
  console.log('3. Testing C compilation, linking, and execution...');
  const helloC = `#include <stdio.h>
int main(void) {
    printf("Hello from WasiHost pure JS!\\n");
    return 0;
}
`;
  vfs.set('/workspace/hello.c', {
    isDir: false,
    data: Buffer.from(helloC),
    mtime: Date.now(),
  });

  const clangCArgs = [
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
    '-O2',
    '-x', 'c',
    '-std=c11',
    '-o', '/workspace/hello.o',
    '/workspace/hello.c',
  ];

  let compilerOutput = '';
  const clangHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: clangCArgs,
    stdout: s => { compilerOutput += s; },
    stderr: s => { compilerOutput += s; },
  });

  const clangCode = await runInstance(clangModule, clangHost);
  if (clangCode !== 0 || !vfs.has('/workspace/hello.o')) {
    console.error('[-] C compilation failed. Code:', clangCode);
    console.error(compilerOutput);
    process.exit(1);
  }
  console.log('[+] C compilation succeeded -> /workspace/hello.o');

  // Link
  const lldCArgs = [
    'wasm-ld',
    '-flavor', 'wasm',
    '-z', 'stack-size=1048576',
    '-L/lib/wasm32-wasip1',
    '-L/lib/clang/19/lib/wasm32-unknown-wasip1',
    '/lib/wasm32-wasip1/crt1.o',
    '/workspace/hello.o',
    '-lc',
    '-lclang_rt.builtins',
    '-o', '/workspace/hello.wasm',
  ];

  let linkerOutput = '';
  const lldHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: lldCArgs,
    stdout: s => { linkerOutput += s; },
    stderr: s => { linkerOutput += s; },
  });

  const lldCode = await runInstance(lldModule, lldHost);
  if (lldCode !== 0 || !vfs.has('/workspace/hello.wasm')) {
    console.error('[-] C linking failed. Code:', lldCode);
    console.error(linkerOutput);
    process.exit(1);
  }
  console.log('[+] C linking succeeded -> /workspace/hello.wasm');

  // Run
  const helloWasm = clangHost._vfsReadFile('/workspace/hello.wasm');
  const helloModule = await WebAssembly.compile(helloWasm);
  let runOutput = '';
  const runHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['hello.wasm'],
    preopens: [{ fd: 3, path: '/workspace', name: '.' }],
    stdout: s => { runOutput += s; },
    stderr: s => { process.stderr.write(s); },
  });

  const runCode = await runInstance(helloModule, runHost);
  console.log('  -> Executed hello.wasm output:', JSON.stringify(runOutput));
  if (runCode !== 0 || runOutput.trim() !== 'Hello from WasiHost pure JS!') {
    console.error(`[-] Unexpected execution output or code: code=${runCode}, output=${runOutput}`);
    process.exit(1);
  }
  console.log('[PASS] C compilation, linking, and execution with WasiHost verified!');

  // 4. Test C++ compilation and execution
  console.log('4. Testing C++ compilation, linking, and execution...');
  const helloCpp = `#include <iostream>
#include <string>
#include <vector>

int main() {
    std::vector<std::string> words = {"WasiHost", "pure", "JS", "C++19"};
    for (size_t i = 0; i < words.size(); ++i) {
        std::cout << words[i] << (i + 1 < words.size() ? " " : "\\n");
    }
    return 0;
}
`;
  vfs.set('/workspace/hello.cpp', {
    isDir: false,
    data: Buffer.from(helloCpp),
    mtime: Date.now(),
  });

  const clangCppArgs = [
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
    '-O2',
    '-x', 'c++',
    '-std=c++17',
    '-o', '/workspace/hello_cpp.o',
    '/workspace/hello.cpp',
  ];

  let cppCompilerOutput = '';
  const clangCppHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: clangCppArgs,
    stdout: s => { cppCompilerOutput += s; },
    stderr: s => { cppCompilerOutput += s; },
  });

  const clangCppCode = await runInstance(clangModule, clangCppHost);
  if (clangCppCode !== 0 || !vfs.has('/workspace/hello_cpp.o')) {
    console.error('[-] C++ compilation failed. Code:', clangCppCode);
    console.error(cppCompilerOutput);
    process.exit(1);
  }
  console.log('[+] C++ compilation succeeded -> /workspace/hello_cpp.o');

  // Link C++
  const lldCppArgs = [
    'wasm-ld',
    '-flavor', 'wasm',
    '-z', 'stack-size=1048576',
    '-L/lib/wasm32-wasip1',
    '-L/lib/clang/19/lib/wasm32-unknown-wasip1',
    '/lib/wasm32-wasip1/crt1.o',
    '/workspace/hello_cpp.o',
    '-lc++',
    '-lc++abi',
    '-lc',
    '-lclang_rt.builtins',
    '-o', '/workspace/hello_cpp.wasm',
  ];

  let cppLinkerOutput = '';
  const lldCppHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: lldCppArgs,
    stdout: s => { cppLinkerOutput += s; },
    stderr: s => { cppLinkerOutput += s; },
  });

  const lldCppCode = await runInstance(lldModule, lldCppHost);
  if (lldCppCode !== 0 || !vfs.has('/workspace/hello_cpp.wasm')) {
    console.error('[-] C++ linking failed. Code:', lldCppCode);
    console.error(cppLinkerOutput);
    process.exit(1);
  }
  console.log('[+] C++ linking succeeded -> /workspace/hello_cpp.wasm');

  // Run C++
  const helloCppWasm = clangCppHost._vfsReadFile('/workspace/hello_cpp.wasm');
  const helloCppModule = await WebAssembly.compile(helloCppWasm);
  let cppRunOutput = '';
  const runCppHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['hello_cpp.wasm'],
    preopens: [{ fd: 3, path: '/workspace', name: '.' }],
    stdout: s => { cppRunOutput += s; },
    stderr: s => { process.stderr.write(s); },
  });

  const runCppCode = await runInstance(helloCppModule, runCppHost);
  console.log('  -> Executed hello_cpp.wasm output:', JSON.stringify(cppRunOutput));
  if (runCppCode !== 0 || cppRunOutput.trim() !== 'WasiHost pure JS C++19') {
    console.error(`[-] Unexpected C++ execution output or code: code=${runCppCode}, output=${cppRunOutput}`);
    process.exit(1);
  }
  console.log('[PASS] C++ compilation, linking, and execution with WasiHost verified!');

  // 5. Test llvm-box multicall tools (ar, nm, size, objdump, cxxfilt)
  console.log('5. Testing llvm-box.wasm multicall utilities...');
  const llvmBoxModule = await WebAssembly.compile(fs.readFileSync(llvmBoxWasmPath));

  // ar rcs libhello.a hello.o
  let arOutput = '';
  const arHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['ar', 'rcs', 'libhello.a', 'hello.o'],
    stdout: s => { arOutput += s; },
    stderr: s => { arOutput += s; },
  });
  const arCode = await runInstance(llvmBoxModule, arHost);
  if (arCode !== 0 || !vfs.has('/workspace/libhello.a')) {
    console.error('[-] ar rcs failed. Code:', arCode, 'Output:', arOutput);
    process.exit(1);
  }
  console.log('[+] ar rcs succeeded -> /workspace/libhello.a');

  // nm libhello.a
  let nmOutput = '';
  const nmHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['nm', 'libhello.a'],
    stdout: s => { nmOutput += s; },
    stderr: s => { nmOutput += s; },
  });
  const nmCode = await runInstance(llvmBoxModule, nmHost);
  if (nmCode !== 0 || !nmOutput.includes('main')) {
    console.error('[-] nm failed. Code:', nmCode, 'Output:', nmOutput);
    process.exit(1);
  }
  console.log('[+] nm succeeded, symbol "main" detected.');

  // size hello.o
  let sizeOutput = '';
  const sizeHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['size', 'hello.o'],
    stdout: s => { sizeOutput += s; },
    stderr: s => { sizeOutput += s; },
  });
  const sizeCode = await runInstance(llvmBoxModule, sizeHost);
  if (sizeCode !== 0 || !sizeOutput.includes('text')) {
    console.error('[-] size failed. Code:', sizeCode, 'Output:', sizeOutput);
    process.exit(1);
  }
  console.log('[+] size succeeded, section headers detected.');

  // objdump -h hello.o
  let objdumpOutput = '';
  const objdumpHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['objdump', '-h', 'hello.o'],
    stdout: s => { objdumpOutput += s; },
    stderr: s => { objdumpOutput += s; },
  });
  const objdumpCode = await runInstance(llvmBoxModule, objdumpHost);
  if (objdumpCode !== 0 || !objdumpOutput.includes('Sections:')) {
    console.error('[-] objdump failed. Code:', objdumpCode, 'Output:', objdumpOutput);
    process.exit(1);
  }
  console.log('[+] objdump succeeded, sections table detected.');

  // cxxfilt _Z3addii
  let cxxfiltOutput = '';
  const cxxfiltHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['cxxfilt', '_Z3addii'],
    stdout: s => { cxxfiltOutput += s; },
    stderr: s => { cxxfiltOutput += s; },
  });
  const cxxfiltCode = await runInstance(llvmBoxModule, cxxfiltHost);
  if (cxxfiltCode !== 0 || !cxxfiltOutput.includes('add(int, int)')) {
    console.error('[-] cxxfilt failed. Code:', cxxfiltCode, 'Output:', cxxfiltOutput);
    process.exit(1);
  }
  console.log('[+] cxxfilt succeeded: _Z3addii -> add(int, int)');
  console.log('[PASS] llvm-box.wasm multicall tools verified!');

  console.log('======================================================');
  console.log('   All WasiHost standalone tests PASSED successfully! ');
  console.log('======================================================');
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
