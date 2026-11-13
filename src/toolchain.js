// High-Level Wasm Toolchain Coordinator for clang-wasi
// Manages llvm-box.wasm lifecycle, compilation stages, and multicall utilities

import { WasiHost, ProcExit, normalizePath } from './wasi-host.js';

export { ProcExit, normalizePath };

/**
 * Helper to check file existence across Map or VFS instances.
 */
function vfsExists(vfs, path) {
  if (!vfs) return false;
  if (typeof vfs.exists === 'function') return vfs.exists(path);
  if (vfs instanceof Map) return vfs.has(path);
  return path in vfs;
}

/**
 * Helper to read file across Map or VFS instances.
 */
function vfsReadFile(vfs, path) {
  if (!vfs) return null;
  if (typeof vfs.readFile === 'function') return vfs.readFile(path, false);
  if (vfs instanceof Map) return vfs.get(path) || null;
  return vfs[path] || null;
}

/**
 * Helper to write file across Map or VFS instances.
 */
function vfsWriteFile(vfs, path, content) {
  if (!vfs) return;
  if (typeof vfs.writeFile === 'function') {
    vfs.writeFile(path, content, Date.now(), true);
  } else if (vfs instanceof Map) {
    vfs.set(path, content);
  } else {
    vfs[path] = content;
  }
}

/**
 * Helper to create directory across Map or VFS instances.
 */
function vfsMkdir(vfs, path) {
  if (!vfs) return;
  if (typeof vfs.mkdir === 'function') {
    try { vfs.mkdir(path, true, true); } catch {}
  } else if (vfs instanceof Map) {
    vfs.set(path, { isDir: true });
  }
}

/**
 * Represents a single instantiated application running under WasiHost.
 */
export class AppInstance {
  constructor(wasiHost, name, ...args) {
    this.argv = [name, ...args];
    this.environ = wasiHost.environ || { USER: 'wasi', HOME: '/workspace', PWD: '/workspace' };
    this.wasiHost = wasiHost;
    this.wasiHost.argv = this.argv;
    this.wasiHost.environ = this.environ;
    this.instance = null;
    this.exports = null;
  }

  _buildImports() {
    this.wasiHost.setMemory(() => (this.instance ? this.instance.exports.memory : null));
    const wasi = typeof this.wasiHost.createImportObject === 'function'
      ? this.wasiHost.createImportObject()
      : { wasi_snapshot_preview1: this.wasiHost.getImports ? this.wasiHost.getImports() : this.wasiHost };

    return {
      ...wasi,
      env: new Proxy({}, {
        get(t, p) {
          if (p in t) return t[p];
          return () => 0;
        }
      }),
    };
  }

  static async create(module, wasiHost, name, ...args) {
    const app = new AppInstance(wasiHost, name, ...args);
    const imports = app._buildImports();
    const res = await WebAssembly.instantiate(module, imports);
    const instance = res instanceof WebAssembly.Instance ? res : (res.instance || res);
    app.instance = instance;
    app.exports = instance.exports;
    return app;
  }

  static createSync(module, wasiHost, name, ...args) {
    const app = new AppInstance(wasiHost, name, ...args);
    const imports = app._buildImports();
    const instance = new WebAssembly.Instance(module, imports);
    app.instance = instance;
    app.exports = instance.exports;
    return app;
  }

  run() {
    try {
      if (typeof this.exports._start === 'function') {
        this.exports._start();
      }
      return 0;
    } catch (err) {
      if (err instanceof ProcExit || (err && err.code !== undefined)) {
        return err.code;
      }
      throw err;
    }
  }
}

/**
 * WasmToolchain manages loading llvm-box.wasm and executing Clang, LLD, and multicall utilities.
 */
export class WasmToolchain {
  constructor(options = {}) {
    this.basePath = (options.basePath || '/sysroot/wasm').replace(/\/+$/, '');
    this.hostWrite = options.hostWrite || console.log;
    this.vfs = options.vfs || null;
    this.llvmBoxModule = options.llvmBoxModule || null;
    this.llvmBoxPromise = null;
    this.initialized = Boolean(this.llvmBoxModule);
    this.initPromise = null;
  }

  async init(onProgress = () => {}) {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!this.llvmBoxModule) {
        onProgress('Loading LLVM toolchain module (llvm-box.wasm)...');
        this.llvmBoxModule = await this._getLlvmBox();
      }
      this.initialized = true;
    })();

    return this.initPromise;
  }

  async _getLlvmBox(options = {}) {
    if (this.llvmBoxModule) return this.llvmBoxModule;
    if (this.llvmBoxPromise) return this.llvmBoxPromise;

    this.llvmBoxPromise = (async () => {
      // 1. If globalThis.fetch is available, attempt fetching from basePath
      if (typeof fetch === 'function') {
        const url = `${this.basePath}/llvm-box.wasm`;
        try {
          const res = await fetch(url);
          if (res && res.ok !== false) {
            if (typeof WebAssembly.compileStreaming === 'function') {
              try {
                const mod = await WebAssembly.compileStreaming(res.clone ? res.clone() : res);
                this.llvmBoxModule = mod;
                return mod;
              } catch (_) {}
            }
            const buf = await res.arrayBuffer();
            const mod = await WebAssembly.compile(buf);
            this.llvmBoxModule = mod;
            return mod;
          }
        } catch (_) {}
      }

      // 2. In Node.js environment, fallback to direct filesystem read
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const { fileURLToPath } = await import('node:url');
          const __dirname = path.dirname(fileURLToPath(import.meta.url));
          const localPaths = [
            path.resolve(__dirname, '../dist/llvm-box.wasm'),
            path.resolve('dist/llvm-box.wasm'),
            path.resolve('build-wasi/bin/llvm.wasm'),
            path.resolve(this.basePath.replace(/^\/+/, ''), 'llvm-box.wasm'),
          ];
          for (const p of localPaths) {
            if (fs.existsSync(p)) {
              const buf = fs.readFileSync(p);
              const mod = await WebAssembly.compile(buf);
              this.llvmBoxModule = mod;
              return mod;
            }
          }
        } catch (_) {}
      }

      throw new Error(`Failed to load llvm-box.wasm from basePath: ${this.basePath}`);
    })();

    return this.llvmBoxPromise;
  }

  async runTool(toolName, toolArgs = [], options = {}) {
    await this.init();
    const llvmBox = this.llvmBoxModule;
    if (!llvmBox) {
      throw new Error('llvm-box module not initialized');
    }
    const cwd = options.cwd || '/workspace';
    const environ = { USER: 'wasi', HOME: '/workspace', PWD: cwd, ...(options.environ || {}) };

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd,
      argv: [toolName, ...toolArgs],
      environ,
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = await AppInstance.create(llvmBox, wasiHost, toolName, ...toolArgs);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  runToolSync(toolName, toolArgs = [], options = {}) {
    const llvmBox = this.llvmBoxModule;
    if (!llvmBox) {
      throw new Error('llvm-box module not initialized');
    }
    const cwd = options.cwd || '/workspace';
    const environ = { USER: 'wasi', HOME: '/workspace', PWD: cwd, ...(options.environ || {}) };

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd,
      argv: [toolName, ...toolArgs],
      environ,
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = AppInstance.createSync(llvmBox, wasiHost, toolName, ...toolArgs);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  async runClang(cmd, args = [], options = {}) {
    await this.init();
    const cwd = options.cwd || '/workspace';
    const binary = (cmd === 'g++' || cmd === 'clang++') ? 'clang++' : 'clang';

    const finalArgs = [];
    if (!args.some(a => a.startsWith('--target'))) {
      finalArgs.push('--target=wasm32-wasip1');
    }
    if (!args.some(a => a.startsWith('--sysroot'))) {
      finalArgs.push('--sysroot=/');
    }
    finalArgs.push(...args);

    return this.runTool(binary, finalArgs, { ...options, cwd });
  }

  runClangSync(cmd, args = [], options = {}) {
    const cwd = options.cwd || '/workspace';
    const binary = (cmd === 'g++' || cmd === 'clang++') ? 'clang++' : 'clang';

    const finalArgs = [];
    if (!args.some(a => a.startsWith('--target'))) {
      finalArgs.push('--target=wasm32-wasip1');
    }
    if (!args.some(a => a.startsWith('--sysroot'))) {
      finalArgs.push('--sysroot=/');
    }
    finalArgs.push(...args);

    return this.runToolSync(binary, finalArgs, { ...options, cwd });
  }

  async runLld(cmd = 'wasm-ld', args = [], options = {}) {
    await this.init();
    const binary = (cmd === 'wasm-ld' || cmd === 'ld' || cmd === 'lld' || cmd === 'ld.lld') ? 'wasm-ld' : cmd;
    return this.runTool(binary, args, options);
  }

  runLldSync(cmd = 'wasm-ld', args = [], options = {}) {
    const binary = (cmd === 'wasm-ld' || cmd === 'ld' || cmd === 'lld' || cmd === 'ld.lld') ? 'wasm-ld' : cmd;
    return this.runToolSync(binary, args, options);
  }

  _buildCompileArgs(sourcePath, objPath, mode = 'c', customFlags = [], options = {}) {
    const cwd = options.cwd || '/workspace';
    const cleanSrc = sourcePath.startsWith('/') ? sourcePath : `${cwd}/${sourcePath}`.replace(/\/+/g, '/');
    const cleanObj = objPath.startsWith('/') ? objPath : (objPath === '-' ? '-' : `${cwd}/${objPath}`.replace(/\/+/g, '/'));

    const stage = options.stage || 'compile';
    const stageFlag = stage === 'preprocess' ? '-E' : (stage === 'assembly' ? '-S' : '-emit-obj');

    const args = [
      '-cc1',
      '-triple', 'wasm32-unknown-wasi',
      stageFlag,
      '-mrelax-all',
      '-disable-free',
      '-isysroot', '/',
    ];

    if (mode === 'cpp' || mode === 'c++') {
      args.push(
        '-internal-isystem', '/include/wasm32-wasip1/c++/v1',
        '-internal-isystem', '/include/c++/v1',
      );
    }

    args.push(
      '-internal-isystem', '/lib/clang/19/include',
      '-internal-isystem', '/lib/clang/19.1.0/include',
      '-internal-isystem', '/include/wasm32-wasip1',
      '-internal-isystem', '/include',
      '-internal-isystem', '/usr/include',
      '-I', `${cwd}/include`.replace(/\/+/g, '/'),
      '-I', cwd,
      '-ferror-limit', '19',
      '-fmessage-length=80',
      '-fcolor-diagnostics',
    );

    // Process PIC and include flags
    const processedFlags = [];
    let isPic = false;
    for (const flag of customFlags) {
      if (flag === '-fPIC' || flag === '-fpic' || flag === '-fPIE' || flag === '-fpie') {
        isPic = true;
      } else if (flag.startsWith('-I') && flag.length > 2) {
        processedFlags.push('-I', flag.substring(2));
      } else {
        processedFlags.push(flag);
      }
    }
    if (isPic) {
      args.push('-mrelocation-model', 'pic', '-pic-level', '2');
    }

    const hasOptFlag = processedFlags.some(f => /^-O[0-3sz]?$/.test(f));
    if (!hasOptFlag) {
      args.push('-O2');
    }

    const hasStdFlag = processedFlags.some(f => f.startsWith('-std='));
    const hasLangFlag = processedFlags.some(f => f === '-x' || f.startsWith('-x'));

    if (!hasLangFlag) {
      args.push('-x', mode === 'c' ? 'c' : 'c++');
    }

    if (!hasStdFlag) {
      args.push(mode === 'c' ? '-std=c17' : '-std=c++17');
    }

    args.push(...processedFlags);
    args.push('-o', cleanObj, cleanSrc);
    return args;
  }

  async compile(sourcePath, objPath, mode = 'c', customFlags = [], options = {}) {
    await this.init();
    const args = this._buildCompileArgs(sourcePath, objPath, mode, customFlags, options);
    const cwd = options.cwd || '/workspace';
    const environ = { USER: 'wasi', HOME: '/workspace', PWD: cwd, ...(options.environ || {}) };

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd,
      environ,
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = await AppInstance.create(this.llvmBoxModule, wasiHost, 'clang', ...args);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  compileSync(sourcePath, objPath, mode = 'c', customFlags = [], options = {}) {
    const args = this._buildCompileArgs(sourcePath, objPath, mode, customFlags, options);
    const cwd = options.cwd || '/workspace';
    const environ = { USER: 'wasi', HOME: '/workspace', PWD: cwd, ...(options.environ || {}) };

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd,
      environ,
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = AppInstance.createSync(this.llvmBoxModule, wasiHost, 'clang', ...args);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  _buildLinkArgs(objPaths, outputPath, customFlags = []) {
    const cleanObjs = objPaths.map(p => (p.startsWith('/') ? p : `/${p}`));
    const cleanOut = outputPath.startsWith('/') ? outputPath : `/${outputPath}`;

    if (this.vfs) {
      const lastSlash = cleanOut.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = cleanOut.substring(0, lastSlash);
        vfsMkdir(this.vfs, dir);
      }
    }

    const isShared = customFlags.includes('-shared') || customFlags.includes('--shared') || cleanOut.endsWith('.so');
    const stackSize = 1024 * 1024;
    const libdir = vfsExists(this.vfs, '/lib/wasm32-wasip1/crt1.o')
      ? '/lib/wasm32-wasip1'
      : '/lib/wasm32-wasi';
    const crt1 = `${libdir}/crt1.o`;

    const explicitAllowUndefined = customFlags.includes('--allow-undefined') || customFlags.includes('-Wl,--allow-undefined');
    const hostImportsPath = '/usr/lib/wasm-host-imports.txt';
    const hasHostImports = vfsExists(this.vfs, hostImportsPath);

    const args = [
      '-flavor', 'wasm',
    ];

    if (isShared) {
      args.push(
        '--shared',
        '--allow-undefined',
        `-L${libdir}`,
        `-L/lib/wasm32-wasip1`,
        `-L/lib/wasm32-wasi`,
        `-L/lib/clang/19/lib/wasm32-unknown-wasip1`,
        `-L/lib/clang/19/lib/wasm32-unknown-wasi`,
        `-L/usr/lib`,
        ...cleanObjs,
        '-lc',
        '-lclang_rt.builtins',
        ...customFlags.filter(f => f !== '-shared' && f !== '--shared'),
        '-o', cleanOut,
      );
    } else {
      if (explicitAllowUndefined || !hasHostImports) {
        args.push('--allow-undefined');
      } else {
        args.push(`--allow-undefined-file=${hostImportsPath}`);
      }
      args.push(
        '-z', `stack-size=${stackSize}`,
        `-L${libdir}`,
        `-L/lib/wasm32-wasip1`,
        `-L/lib/wasm32-wasi`,
        `-L/lib/clang/19/lib/wasm32-unknown-wasip1`,
        `-L/lib/clang/19/lib/wasm32-unknown-wasi`,
        `-L/usr/lib`,
        crt1,
        ...cleanObjs,
        '-lc',
        '-lclang_rt.builtins',
        '-lc++',
        '-lc++abi',
        ...customFlags.filter(f => f !== '--allow-undefined' && f !== '-Wl,--allow-undefined'),
        '-o', cleanOut,
      );
    }
    return args;
  }

  async link(objPaths, outputPath, customFlags = []) {
    await this.init();
    const args = this._buildLinkArgs(objPaths, outputPath, customFlags);

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd: '/workspace',
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = await AppInstance.create(this.llvmBoxModule, wasiHost, 'wasm-ld', ...args);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  linkSync(objPaths, outputPath, customFlags = []) {
    const args = this._buildLinkArgs(objPaths, outputPath, customFlags);

    const wasiHost = new WasiHost({
      vfs: this.vfs,
      cwd: '/workspace',
      stdout: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
      stderr: (str) => {
        if (typeof this.hostWrite === 'function') this.hostWrite(str);
      },
    });

    try {
      const app = AppInstance.createSync(this.llvmBoxModule, wasiHost, 'wasm-ld', ...args);
      return app.run();
    } finally {
      wasiHost.setMemory(null);
    }
  }

  syncFile(path, content) {
    const cleanPath = (path || '').replace(/^\/+/, '');
    vfsWriteFile(this.vfs, '/' + cleanPath, content);
  }

  getFile(path) {
    const cleanPath = (path || '').replace(/^\/+/, '');
    if (vfsExists(this.vfs, '/' + cleanPath)) return vfsReadFile(this.vfs, '/' + cleanPath);
    if (vfsExists(this.vfs, '/workspace/' + cleanPath)) return vfsReadFile(this.vfs, '/workspace/' + cleanPath);
    if (vfsExists(this.vfs, path)) return vfsReadFile(this.vfs, path);
    return null;
  }

  hasFile(path) {
    const cleanPath = (path || '').replace(/^\/+/, '');
    return vfsExists(this.vfs, '/' + cleanPath) || vfsExists(this.vfs, '/workspace/' + cleanPath) || vfsExists(this.vfs, path);
  }
}
