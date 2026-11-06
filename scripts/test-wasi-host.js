#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { WasiHost, ProcExit, MemoryPipe } = require('../src/wasi-host.js');

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
  const llvmBoxWasmPath = path.join(distDir, 'llvm-box.wasm');
  const sysrootGzPath = path.join(distDir, 'sysroot.tar.gz');

  if (!fs.existsSync(llvmBoxWasmPath) || !fs.existsSync(sysrootGzPath)) {
    console.error('Error: Missing required dist files (llvm-box.wasm, sysroot.tar.gz).');
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
  console.log('2. Compiling llvm-box.wasm WebAssembly module...');
  const llvmBoxModule = await WebAssembly.compile(fs.readFileSync(llvmBoxWasmPath));
  console.log('[+] Module compiled.');

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

  const clangCode = await runInstance(llvmBoxModule, clangHost);
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

  const lldCode = await runInstance(llvmBoxModule, lldHost);
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

  const clangCppCode = await runInstance(llvmBoxModule, clangCppHost);
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

  const lldCppCode = await runInstance(llvmBoxModule, lldCppHost);
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

  // 6. Test WasiHost UTF-8 decoding and poll_oneoff clock delay
  console.log('6. Testing WasiHost UTF-8 decoding and poll_oneoff...');
  const testHost = new WasiHost({ vfs, cwd: '/workspace' });
  const testBuf = new Uint8Array(1024);
  testHost.setMemory(() => testBuf);
  const imports = testHost.createImportObject();
  const encoder = new TextEncoder();
  const encoded = encoder.encode('Hello, 世界! ┌─┐\0');
  testBuf.set(encoded, 100);
  const decoded = testHost.readStr(100);
  if (decoded !== 'Hello, 世界! ┌─┐') {
    console.error('[-] UTF-8 decode failed:', decoded);
    process.exit(1);
  }
  console.log('[+] UTF-8 decode succeeded:', decoded);

  const view = new DataView(testBuf.buffer);
  const inPtr = 200;
  const outPtr = 300;
  const neventsOutPtr = 400;

  view.setBigUint64(inPtr, 12345n, true);
  view.setUint8(inPtr + 8, 0); // __WASI_EVENTTYPE_CLOCK
  view.setBigUint64(inPtr + 24, 15000000n, true); // 15ms in ns
  view.setUint16(inPtr + 40, 0, true); // relative

  const startClock = Date.now();
  const pollRes = imports.wasi_snapshot_preview1.poll_oneoff(inPtr, outPtr, 1, neventsOutPtr);
  const elapsed = Date.now() - startClock;
  const neventsReported = view.getUint32(neventsOutPtr, true);
  const outUserdata = view.getBigUint64(outPtr, true);
  const outError = view.getUint16(outPtr + 8, true);

  if (pollRes !== 0 || neventsReported !== 1 || outUserdata !== 12345n || outError !== 0 || elapsed < 5) {
    console.error('[-] poll_oneoff test failed:', { pollRes, neventsReported, outUserdata, outError, elapsed });
    process.exit(1);
  }
  console.log(`[+] poll_oneoff clock delay succeeded (${elapsed}ms elapsed).`);
  console.log('[PASS] WasiHost UTF-8 and clock delay verified!');

  // 7. Testing MemoryPipe and host pipe / builtins
  console.log('7. Testing MemoryPipe and host pipe / builtins...');

  // 7a. Unit test MemoryPipe chunk buffering and slice reading
  const pipe = new MemoryPipe();
  assert.strictEqual(pipe.totalLen, 0);
  assert.strictEqual(pipe.closed, false);
  assert.strictEqual(pipe.writeRefs, 0);

  // Write multiple chunks
  pipe.write(new Uint8Array([1, 2, 3]));
  pipe.write(new Uint8Array([4, 5, 6, 7]));
  pipe.write(new Uint8Array([8, 9]));
  assert.strictEqual(pipe.totalLen, 9);

  // Read partial head chunk
  const r1 = pipe.read(2);
  assert.deepStrictEqual(Array.from(r1), [1, 2]);
  assert.strictEqual(pipe.totalLen, 7);

  // Read across chunk boundary (remainder of chunk 1 + part of chunk 2)
  const r2 = pipe.read(3);
  assert.deepStrictEqual(Array.from(r2), [3, 4, 5]);
  assert.strictEqual(pipe.totalLen, 4);

  // Read asking for more than remaining bytes (should clamp to remaining totalLen)
  const r3 = pipe.read(100);
  assert.deepStrictEqual(Array.from(r3), [6, 7, 8, 9]);
  assert.strictEqual(pipe.totalLen, 0);

  // Read from empty pipe
  const r4 = pipe.read(10);
  assert.strictEqual(r4.length, 0);

  // Close pipe and verify writes are rejected
  pipe.close();
  assert.strictEqual(pipe.closed, true);
  assert.strictEqual(pipe.write(new Uint8Array([10, 11])), 0);
  console.log('[+] MemoryPipe chunk buffering, boundary slicing, and close verified.');

  // 7b. WasiHost pipe subsystem and write-reference counting
  const pipeHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    hostBuiltinLookup: (name) => name === 'test_builtin',
    hostBuiltinName: (idx) => idx === 0 ? 'test_builtin' : null,
    hostBuiltinRun: ({ cwd, argc, argv, envp }) => {
      return argv[0] === 'test_builtin' ? 42 : 127;
    },
  });
  const memBuf = new Uint8Array(65536);
  pipeHost.setMemory(() => memBuf);
  const pipeImports = pipeHost.createImportObject();
  const memView = new DataView(memBuf.buffer);

  // Create pipe via __host_pipe
  const pipePtr = 1000;
  const pipeRet = pipeImports.env.__host_pipe(pipePtr);
  assert.strictEqual(pipeRet, 0);
  const rfd = memView.getInt32(pipePtr, true);
  const wfd = memView.getInt32(pipePtr + 4, true);
  assert.ok(rfd > 0 && wfd > 0 && rfd !== wfd);

  const rFile = pipeHost.openFiles.get(rfd);
  const wFile = pipeHost.openFiles.get(wfd);
  assert.ok(rFile && rFile.isPipeRead && rFile.canRead);
  assert.ok(wFile && wFile.isPipeWrite && wFile.canWrite);
  assert.strictEqual(wFile.pipe.writeRefs, 1);
  assert.strictEqual(wFile.pipe.closed, false);

  // Write through fd_write
  const testMsg = new TextEncoder().encode('Hello, MemoryPipe WASI!');
  const msgPtr = 2000;
  memBuf.set(testMsg, msgPtr);
  const iovsPtr = 3000;
  memView.setUint32(iovsPtr, msgPtr, true);
  memView.setUint32(iovsPtr + 4, testMsg.length, true);
  const nwrittenPtr = 3040;

  const writeRes = pipeImports.wasi_snapshot_preview1.fd_write(wfd, iovsPtr, 1, nwrittenPtr);
  assert.strictEqual(writeRes, 0);
  assert.strictEqual(memView.getUint32(nwrittenPtr, true), testMsg.length);
  assert.strictEqual(wFile.pipe.totalLen, testMsg.length);

  // Duplicate writer using __host_dup
  const dupWfd = pipeImports.env.__host_dup(wfd);
  assert.ok(dupWfd > 0 && dupWfd !== wfd);
  assert.strictEqual(wFile.pipe.writeRefs, 2);

  // Duplicate writer to specific FD using __host_dup2
  const targetWfd = 42;
  const dup2Ret = pipeImports.env.__host_dup2(dupWfd, targetWfd);
  assert.strictEqual(dup2Ret, targetWfd);
  assert.strictEqual(wFile.pipe.writeRefs, 3);

  // Close original wfd (writeRefs 3 -> 2; pipe remains open)
  pipeImports.wasi_snapshot_preview1.fd_close(wfd);
  assert.strictEqual(wFile.pipe.writeRefs, 2);
  assert.strictEqual(wFile.pipe.closed, false);

  // Close dupWfd (writeRefs 2 -> 1; pipe remains open)
  pipeImports.wasi_snapshot_preview1.fd_close(dupWfd);
  assert.strictEqual(wFile.pipe.writeRefs, 1);
  assert.strictEqual(wFile.pipe.closed, false);

  // Read from rfd while targetWfd is still open
  const readBufPtr = 4000;
  const readIovsPtr = 4500;
  memView.setUint32(readIovsPtr, readBufPtr, true);
  memView.setUint32(readIovsPtr + 4, 128, true);
  const nreadPtr = 4560;

  const readRes1 = pipeImports.wasi_snapshot_preview1.fd_read(rfd, readIovsPtr, 1, nreadPtr);
  assert.strictEqual(readRes1, 0);
  const nread1 = memView.getUint32(nreadPtr, true);
  assert.strictEqual(nread1, testMsg.length);
  const readStr = new TextDecoder().decode(memBuf.subarray(readBufPtr, readBufPtr + nread1));
  assert.strictEqual(readStr, 'Hello, MemoryPipe WASI!');

  // Overwrite targetWfd using __host_dup2(0, targetWfd): replaces pipe writer with fd 0
  pipeImports.env.__host_dup2(0, targetWfd);
  assert.strictEqual(wFile.pipe.writeRefs, 0);
  assert.strictEqual(wFile.pipe.closed, true);

  // Subsequent fd_read on rfd should return EOF (0 bytes read)
  const readRes2 = pipeImports.wasi_snapshot_preview1.fd_read(rfd, readIovsPtr, 1, nreadPtr);
  assert.strictEqual(readRes2, 0);
  assert.strictEqual(memView.getUint32(nreadPtr, true), 0);

  // Close rfd
  pipeImports.wasi_snapshot_preview1.fd_close(rfd);
  assert.strictEqual(pipeHost.openFiles.has(rfd), false);
  console.log('[+] WasiHost __host_pipe, fd_write, fd_read, __host_dup, __host_dup2 ref-counting verified.');

  // 7c. Host builtin lookup, name, and run
  const cmdStr = new TextEncoder().encode('test_builtin\0');
  memBuf.set(cmdStr, 5000);
  const lookupMatch = pipeImports.env.__host_builtin_lookup(5000, 12);
  assert.strictEqual(lookupMatch, 1);

  const missingCmdStr = new TextEncoder().encode('nonexistent\0');
  memBuf.set(missingCmdStr, 5020);
  const lookupMissing = pipeImports.env.__host_builtin_lookup(5020, 11);
  assert.strictEqual(lookupMissing, 0);

  const nameBufPtr = 5100;
  const nameLen = pipeImports.env.__host_builtin_name(0, nameBufPtr, 32);
  assert.strictEqual(nameLen, 12);
  const retrievedName = new TextDecoder().decode(memBuf.subarray(nameBufPtr, nameBufPtr + nameLen));
  assert.strictEqual(retrievedName, 'test_builtin');
  const nameLenMissing = pipeImports.env.__host_builtin_name(1, nameBufPtr, 32);
  assert.strictEqual(nameLenMissing, 0);

  const cwdPtr = 5200;
  memBuf.set(new TextEncoder().encode('/workspace\0'), cwdPtr);
  const arg0Ptr = 5250;
  memBuf.set(new TextEncoder().encode('test_builtin\0'), arg0Ptr);
  const arg1Ptr = 5270;
  memBuf.set(new TextEncoder().encode('--test-flag\0'), arg1Ptr);
  const argvArrayPtr = 5300;
  memView.setUint32(argvArrayPtr, arg0Ptr, true);
  memView.setUint32(argvArrayPtr + 4, arg1Ptr, true);
  const envpArrayPtr = 5350;
  memView.setUint32(envpArrayPtr, 0, true);

  const builtinRunRes = pipeImports.env.__host_builtin_run(cwdPtr, 2, argvArrayPtr, envpArrayPtr);
  assert.strictEqual(builtinRunRes, 42);

  const spawnRes = pipeImports.env.wasi_host_spawn(arg0Ptr, argvArrayPtr, envpArrayPtr);
  assert.strictEqual(spawnRes, 42);
  console.log('[+] WasiHost host builtin lookup, name, run, and wasi_host_spawn verified.');
  console.log('[PASS] MemoryPipe and host builtin subsystem verified!');

  console.log('======================================================');
  console.log('   All WasiHost standalone tests PASSED successfully! ');
  console.log('======================================================');
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
