#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  WasiHost,
  ProcExit,
  WasmToolchain,
  AppInstance,
  parseCompilerArgs,
  executeGccCommand,
  executeLdCommand,
  executeToolCommand,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  console.log('   clang-wasi Compiler Driver & Toolchain Test Suite  ');
  console.log('======================================================');

  // ---------------------------------------------------------------
  // 1. Unit Tests for parseCompilerArgs
  // ---------------------------------------------------------------
  console.log('1. Testing parseCompilerArgs argument parsing...');

  // Test 1.1: Preprocess stage (-E)
  const p1 = parseCompilerArgs(['-E', 'main.c', '-o', 'main.i'], '/workspace');
  assert.strictEqual(p1.stage, 'preprocess');
  assert.strictEqual(p1.outputFile, 'main.i');
  assert.deepStrictEqual(p1.sources, ['main.c']);

  // Test 1.2: Assembly stage (-S)
  const p2 = parseCompilerArgs(['-S', 'main.c', '-o', 'main.s'], '/workspace');
  assert.strictEqual(p2.stage, 'assembly');
  assert.strictEqual(p2.outputFile, 'main.s');
  assert.deepStrictEqual(p2.sources, ['main.c']);

  // Test 1.3: Compile stage (-c) with attached -o
  const p3 = parseCompilerArgs(['-c', 'src/foo.c', '-obuild/foo.o'], '/workspace');
  assert.strictEqual(p3.stage, 'compile');
  assert.strictEqual(p3.compileOnly, true);
  assert.strictEqual(p3.outputFile, 'build/foo.o');
  assert.deepStrictEqual(p3.sources, ['src/foo.c']);

  // Test 1.4: Include flags (-I dir and -Idir)
  const p4 = parseCompilerArgs(['-I', 'include', '-I/usr/local/include', 'main.c'], '/workspace');
  assert.ok(p4.compilerFlags.includes('-I/workspace/include'));
  assert.ok(p4.compilerFlags.includes('-I/usr/local/include'));

  // Test 1.5: Library search paths and libraries (-L, -l)
  const p5 = parseCompilerArgs(['-L', 'lib', '-L/usr/lib', '-lfoo', '-l', 'bar', 'main.o'], '/workspace');
  assert.ok(p5.linkerFlags.includes('-Lworkspace/lib'));
  assert.ok(p5.linkerFlags.includes('-Lusr/lib'));
  assert.ok(p5.linkerFlags.includes('-lfoo'));
  assert.ok(p5.linkerFlags.includes('-lbar'));
  assert.deepStrictEqual(p5.objects, ['main.o']);

  // Test 1.6: Defines and undefines (-D, -U)
  const p6 = parseCompilerArgs(['-D', 'DEBUG=1', '-DVERSION=2', '-U', 'NDEBUG', 'main.c'], '/workspace');
  assert.ok(p6.compilerFlags.includes('-D'));
  assert.ok(p6.compilerFlags.includes('DEBUG=1'));
  assert.ok(p6.compilerFlags.includes('-DVERSION=2'));
  assert.ok(p6.compilerFlags.includes('-U'));
  assert.ok(p6.compilerFlags.includes('NDEBUG'));

  // Test 1.7: Shared library flags and -Wl passthrough
  const p7 = parseCompilerArgs(['-shared', '--allow-undefined', '-Wl,-z,stack-size=65536', 'lib.o'], '/workspace');
  assert.ok(p7.linkerFlags.includes('-shared'));
  assert.ok(p7.linkerFlags.includes('--allow-undefined'));
  assert.ok(p7.linkerFlags.includes('-z'));
  assert.ok(p7.linkerFlags.includes('stack-size=65536'));

  // Test 1.8: Mixed sources and objects
  const p8 = parseCompilerArgs(['main.c', 'helper.cpp', 'util.o', 'libext.a', '-o', 'app.wasm'], '/workspace');
  assert.strictEqual(p8.stage, null); // full link
  assert.deepStrictEqual(p8.sources, ['main.c', 'helper.cpp']);
  assert.deepStrictEqual(p8.objects, ['util.o', 'libext.a']);
  assert.strictEqual(p8.outputFile, 'app.wasm');

  console.log('[PASS] parseCompilerArgs verified across all stages and flag variants!');

  // ---------------------------------------------------------------
  // 2. Sysroot Initialization & Toolchain Setup
  // ---------------------------------------------------------------
  console.log('2. Initializing in-memory VFS & WasmToolchain...');
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const llvmBoxWasmPath = path.join(distDir, 'llvm-box.wasm');
  const sysrootGzPath = path.join(distDir, 'sysroot.tar.gz');

  assert.ok(fs.existsSync(llvmBoxWasmPath), 'dist/llvm-box.wasm must exist');
  assert.ok(fs.existsSync(sysrootGzPath), 'dist/sysroot.tar.gz must exist');

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

  // Resolve symlinks
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
  console.log(`[+] Sysroot populated with ${vfs.size} VFS entries.`);

  const toolchain = new WasmToolchain({ vfs, basePath: distDir });
  let terminalOutput = '';
  const write = (str) => {
    terminalOutput += str;
  };

  await toolchain.init();
  console.log('[+] WasmToolchain initialized successfully.');

  // ---------------------------------------------------------------
  // 3. Testing executeGccCommand: Compile Stage (-c)
  // ---------------------------------------------------------------
  console.log('3. Testing executeGccCommand compile stage (-c)...');
  const mathSource = `
int add(int a, int b) {
    return a + b;
}
int sub(int a, int b) {
    return a - b;
}
`;
  vfs.set('/workspace/math.c', new TextEncoder().encode(mathSource));

  const cCode = await executeGccCommand({
    cmd: 'gcc',
    args: ['-c', 'math.c', '-o', 'math.o'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(cCode, 0, `gcc -c failed with exit code ${cCode}: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/math.o'), '/workspace/math.o must exist in VFS');
  console.log('[PASS] executeGccCommand successfully compiled math.c -> math.o!');

  // ---------------------------------------------------------------
  // 4. Testing executeToolCommand: nm & ar multicall utilities
  // ---------------------------------------------------------------
  console.log('4. Testing executeToolCommand with nm and ar...');
  terminalOutput = '';
  const nmCode = await executeToolCommand({
    cmd: 'nm',
    args: ['math.o'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(nmCode, 0, `nm failed: ${terminalOutput}`);
  assert.ok(terminalOutput.includes('add'), `nm output must contain symbol 'add': ${terminalOutput}`);
  assert.ok(terminalOutput.includes('sub'), `nm output must contain symbol 'sub': ${terminalOutput}`);
  console.log('[PASS] executeToolCommand nm verified symbol extraction.');

  // Create static archive libmath.a using ar rcs
  terminalOutput = '';
  const arCode = await executeToolCommand({
    cmd: 'ar',
    args: ['rcs', 'libmath.a', 'math.o'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(arCode, 0, `ar rcs failed: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/libmath.a'), '/workspace/libmath.a must exist in VFS');
  const arHeader = new TextDecoder().decode(vfs.get('/workspace/libmath.a').slice(0, 8));
  assert.strictEqual(arHeader, '!<arch>\n', 'Archive must have standard !<arch>\\n magic');
  console.log('[PASS] executeToolCommand ar rcs created valid static archive.');

  // ---------------------------------------------------------------
  // 5. Testing executeGccCommand: Full Build & Link (Executable)
  // ---------------------------------------------------------------
  console.log('5. Testing executeGccCommand full build and link (generic default, no forced pedantic)...');
  const mainSource = `
#include <stdio.h>
int add(int a, int b);
int sub(int a, int b);

int main() {
    printf("Math result: %d\\n", add(10, sub(7, 3)));
    return 0;
}
`;
  vfs.set('/workspace/main.c', new TextEncoder().encode(mainSource));

  terminalOutput = '';
  const linkCode = await executeGccCommand({
    cmd: 'gcc',
    args: ['main.c', 'libmath.a', '-o', 'main.wasm'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(linkCode, 0, `gcc link failed: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/main.wasm'), '/workspace/main.wasm must exist in VFS');

  // Execute generated main.wasm via WasiHost to verify ABI and execution
  const wasmBytes = vfs.get('/workspace/main.wasm');
  const wasmModule = await WebAssembly.compile(wasmBytes);
  let execStdout = '';
  const execHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['main.wasm'],
    stdout: (s) => { execStdout += s; },
  });
  const execExit = await runInstance(wasmModule, execHost);
  assert.strictEqual(execExit, 0, `Executable exited with ${execExit}`);
  assert.strictEqual(execStdout, 'Math result: 14\n', `Unexpected executable output: ${execStdout}`);
  console.log(`[PASS] Built executable verified: output = "${execStdout.trim()}"`);

  // ---------------------------------------------------------------
  // 6. Testing executeToolCommand: size & cxxfilt
  // ---------------------------------------------------------------
  console.log('6. Testing executeToolCommand with size and cxxfilt...');
  terminalOutput = '';
  const sizeCode = await executeToolCommand({
    cmd: 'size',
    args: ['main.wasm'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(sizeCode, 0, `size failed: ${terminalOutput}`);
  assert.ok(terminalOutput.includes('total') || terminalOutput.includes('main.wasm'), `size output format: ${terminalOutput}`);

  terminalOutput = '';
  const cxxfiltCode = await executeToolCommand({
    cmd: 'cxxfilt',
    args: ['_Z3fooi', '_Z3addii'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(cxxfiltCode, 0, `cxxfilt failed: ${terminalOutput}`);
  assert.ok(terminalOutput.includes('foo(int)'), `cxxfilt output: ${terminalOutput}`);
  assert.ok(terminalOutput.includes('add(int, int)'), `cxxfilt output: ${terminalOutput}`);
  console.log('[PASS] executeToolCommand size and cxxfilt verified.');

  // ---------------------------------------------------------------
  // 7. Testing executeGccCommand: C++ compilation and execution
  // ---------------------------------------------------------------
  console.log('7. Testing executeGccCommand C++ compilation and execution...');
  const cppSource = `
#include <iostream>
#include <string>

int main() {
    std::string s = "C++17 WasmToolchain Driver";
    std::cout << s << " OK" << std::endl;
    return 0;
}
`;
  vfs.set('/workspace/app.cpp', new TextEncoder().encode(cppSource));

  terminalOutput = '';
  const cppCode = await executeGccCommand({
    cmd: 'g++',
    args: ['app.cpp', '-o', 'cpp_app.wasm'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(cppCode, 0, `g++ failed: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/cpp_app.wasm'), '/workspace/cpp_app.wasm must exist');

  const cppBytes = vfs.get('/workspace/cpp_app.wasm');
  const cppMod = await WebAssembly.compile(cppBytes);
  let cppStdout = '';
  const cppHost = new WasiHost({
    vfs,
    cwd: '/workspace',
    argv: ['cpp_app.wasm'],
    stdout: (s) => { cppStdout += s; },
  });
  const cppExit = await runInstance(cppMod, cppHost);
  assert.strictEqual(cppExit, 0, `C++ app exited with ${cppExit}`);
  assert.strictEqual(cppStdout, 'C++17 WasmToolchain Driver OK\n', `Unexpected C++ output: ${cppStdout}`);
  console.log(`[PASS] C++ compilation and execution verified: "${cppStdout.trim()}"`);

  // ---------------------------------------------------------------
  // 8. Testing executeGccCommand: Preprocess (-E) and Assembly (-S)
  // ---------------------------------------------------------------
  console.log('8. Testing executeGccCommand preprocess (-E) and assembly (-S)...');
  terminalOutput = '';
  const eCode = await executeGccCommand({
    cmd: 'gcc',
    args: ['-E', 'math.c', '-o', 'math.i'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(eCode, 0, `gcc -E failed: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/math.i'), '/workspace/math.i must exist');
  const iContent = new TextDecoder().decode(vfs.get('/workspace/math.i')?.data || vfs.get('/workspace/math.i'));
  assert.ok(iContent.includes('int add(int a, int b)'), 'Preprocessed file must contain source text');

  terminalOutput = '';
  const sCode = await executeGccCommand({
    cmd: 'gcc',
    args: ['-S', 'math.c', '-o', 'math.s'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(sCode, 0, `gcc -S failed: ${terminalOutput}`);
  assert.ok(vfs.has('/workspace/math.s'), '/workspace/math.s must exist');
  console.log('[PASS] executeGccCommand preprocess and assembly stages verified.');

  // ---------------------------------------------------------------
  // 9. Testing executeLdCommand: Direct Linker Invocation
  // ---------------------------------------------------------------
  console.log('9. Testing executeLdCommand direct linker invocation...');
  terminalOutput = '';
  const ldCode = await executeLdCommand({
    cmd: 'wasm-ld',
    args: ['--help'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  assert.strictEqual(ldCode, 0, `wasm-ld --help failed: ${terminalOutput}`);
  assert.ok(terminalOutput.includes('OVERVIEW: LLVM Linker') || terminalOutput.includes('USAGE: wasm-ld'), `wasm-ld output: ${terminalOutput}`);
  console.log('[PASS] executeLdCommand verified.');

  // ---------------------------------------------------------------
  // 10. Testing caller-controlled pedantic and standard flags
  // ---------------------------------------------------------------
  console.log('10. Testing caller-controlled flags (-pedantic-errors, -std=c99)...');
  terminalOutput = '';
  const pedanticCode = await executeGccCommand({
    cmd: 'gcc',
    args: ['-c', '-pedantic-errors', '-Werror', 'main.c', '-o', 'pedantic.o'],
    cwd: '/workspace',
    vfs,
    toolchain,
    write,
  });
  // Should fail because main() lacks prototype (void) under explicit -pedantic-errors -Werror
  assert.strictEqual(pedanticCode, 1, 'Compilation with explicit -pedantic-errors -Werror should reject unprototyped main()');
  assert.ok(terminalOutput.includes('deprecated') || terminalOutput.includes('pedantic'), 'Output contains pedantic diagnostic');
  console.log('[PASS] Explicit caller flags (-pedantic-errors) faithfully forwarded without hardcoding.');

  console.log('======================================================');
  console.log('   All Driver & Toolchain tests PASSED successfully!  ');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('[FAIL] Test threw unhandled error:', err);
  process.exit(1);
});
