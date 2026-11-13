// Toolchain CLI Driver for gcc / clang / wasm-ld backed directly by VFS
// Part of clang-wasi

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
 * Parses compiler command-line arguments into structured stages and flags.
 */
export function parseCompilerArgs(args = [], cwd = '/workspace') {
  let stage = null; // 'preprocess' (-E), 'assembly' (-S), 'compile' (-c), or null (link)
  let outputFile = null;
  const sources = [];
  const objects = [];
  const compilerFlags = [];
  const linkerFlags = [];

  const resolve = (p) => {
    if (!p) return '';
    if (p.startsWith('/')) return p;
    return `${cwd}/${p}`.replace(/\/+/g, '/');
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-E') {
      stage = 'preprocess';
    } else if (arg === '-S') {
      stage = 'assembly';
    } else if (arg === '-c') {
      stage = 'compile';
    } else if (arg === '-o') {
      if (i + 1 < args.length) {
        outputFile = args[++i];
      }
    } else if (arg.startsWith('-o') && arg.length > 2) {
      outputFile = arg.substring(2);
    } else if (arg === '-v') {
      compilerFlags.push('-v');
      linkerFlags.push('-v');
    } else if (arg === '-I') {
      if (i + 1 < args.length) {
        const dir = args[++i];
        compilerFlags.push(`-I${resolve(dir)}`);
      }
    } else if (arg.startsWith('-I')) {
      const dir = arg.substring(2);
      compilerFlags.push(`-I${resolve(dir)}`);
    } else if (arg === '-L') {
      if (i + 1 < args.length) {
        const dir = args[++i];
        const cleanDir = resolve(dir).replace(/^\/+/, '');
        linkerFlags.push(`-L${cleanDir}`);
      }
    } else if (arg.startsWith('-L')) {
      const dir = arg.substring(2);
      const cleanDir = resolve(dir).replace(/^\/+/, '');
      linkerFlags.push(`-L${cleanDir}`);
    } else if (arg === '-l') {
      if (i + 1 < args.length) {
        linkerFlags.push(`-l${args[++i]}`);
      }
    } else if (arg.startsWith('-l')) {
      linkerFlags.push(arg);
    } else if (arg === '-D') {
      if (i + 1 < args.length) {
        compilerFlags.push('-D', args[++i]);
      }
    } else if (arg.startsWith('-D')) {
      compilerFlags.push(arg);
    } else if (arg === '-U') {
      if (i + 1 < args.length) {
        compilerFlags.push('-U', args[++i]);
      }
    } else if (arg.startsWith('-U')) {
      compilerFlags.push(arg);
    } else if (arg === '-shared' || arg === '--shared') {
      linkerFlags.push('-shared');
    } else if (arg === '--allow-undefined') {
      linkerFlags.push('--allow-undefined');
    } else if (arg.startsWith('-Wl,')) {
      linkerFlags.push(...arg.substring(4).split(','));
    } else if (arg.startsWith('-')) {
      compilerFlags.push(arg);
    } else if (
      arg.endsWith('.c') ||
      arg.endsWith('.cpp') ||
      arg.endsWith('.cc') ||
      arg.endsWith('.cxx') ||
      arg.endsWith('.c++') ||
      arg.endsWith('.i') ||
      arg.endsWith('.ii') ||
      arg.endsWith('.s')
    ) {
      sources.push(arg);
    } else if (arg.endsWith('.o') || arg.endsWith('.a') || arg.endsWith('.so')) {
      objects.push(arg);
    }
  }

  return {
    stage,
    compileOnly: stage === 'compile',
    outputFile,
    sources,
    objects,
    compilerFlags,
    linkerFlags,
    flags: [...compilerFlags, ...linkerFlags],
  };
}

/**
 * Executes a GCC / Clang compiler command line against the VFS and WasmToolchain.
 */
export async function executeGccCommand({
  cmd,
  args,
  cwd = '/workspace',
  environ = {},
  vfs,
  toolchain,
  mode,
  write,
}) {
  const { stage, outputFile, sources, objects, compilerFlags, linkerFlags } = parseCompilerArgs(args, cwd);

  const resolve = (p) => {
    if (!p) return '';
    if (p.startsWith('/')) return p;
    return `${cwd}/${p}`.replace(/\/+/g, '/');
  };

  if (toolchain && typeof toolchain.init === 'function') {
    await toolchain.init();
  }

  const prevHostWrite = toolchain ? toolchain.hostWrite : null;
  if (toolchain) {
    toolchain.hostWrite = (str) => {
      if (typeof write === 'function') {
        write(str);
      } else if (typeof prevHostWrite === 'function') {
        prevHostWrite(str);
      }
    };
  }

  try {
    // If no input files (sources or objects) were provided, delegate directly to the
    // official toolchain (e.g. gcc --help, gcc -v, gcc --version, clang --help)
    if (sources.length === 0 && objects.length === 0) {
      if (toolchain && typeof toolchain.runClang === 'function') {
        return await toolchain.runClang(cmd, args, { cwd, environ });
      }
      if (typeof write === 'function') write(`${cmd || 'gcc'}: fatal error: no input files\r\n`);
      return 1;
    }

    const ensureParentDir = (filePath) => {
      const norm = resolve(filePath);
      const lastSlash = norm.lastIndexOf('/');
      if (lastSlash > 0) {
        const dirPath = norm.substring(0, lastSlash);
        if (!vfsExists(vfs, dirPath)) {
          vfsMkdir(vfs, dirPath);
        }
      }
    };

    // Validate that all input source files exist in VFS
    for (const src of sources) {
      const srcResolved = resolve(src);
      if (!vfsExists(vfs, srcResolved)) {
        if (typeof write === 'function') write(`${cmd || 'gcc'}: error: ${src}: No such file or directory\r\n`);
        return 1;
      }
    }

    // Validate that all input object/library files exist in VFS
    for (const obj of objects) {
      const objResolved = resolve(obj);
      if (!vfsExists(vfs, objResolved)) {
        if (typeof write === 'function') write(`${cmd || 'gcc'}: error: ${obj}: No such file or directory\r\n`);
        return 1;
      }
    }

    const effectiveMode = (cmd === 'g++' || cmd === 'clang++') ? 'cpp' : (mode || 'c');

    // Stage: Preprocess (-E)
    if (stage === 'preprocess') {
      if (sources.length === 0) {
        if (typeof write === 'function') write(`${cmd || 'gcc'}: fatal error: no input files\r\n`);
        return 1;
      }

      for (const src of sources) {
        const srcResolved = resolve(src);
        if (outputFile && outputFile !== '-') {
          const outResolved = resolve(outputFile);
          ensureParentDir(outResolved);
          const exitCode = await toolchain.compile(
            srcResolved,
            outResolved,
            effectiveMode,
            compilerFlags,
            { stage: 'preprocess', cwd, environ }
          );
          if (exitCode !== 0) return exitCode;
        } else {
          const exitCode = await toolchain.compile(
            srcResolved,
            '-',
            effectiveMode,
            compilerFlags,
            { stage: 'preprocess', cwd, environ }
          );
          if (exitCode !== 0) return exitCode;
        }
      }
      return 0;
    }

    // Stage: Assembly (-S)
    if (stage === 'assembly') {
      if (sources.length === 0) {
        if (typeof write === 'function') write(`${cmd || 'gcc'}: fatal error: no input files\r\n`);
        return 1;
      }

      for (const src of sources) {
        const srcResolved = resolve(src);
        if (outputFile === '-') {
          const exitCode = await toolchain.compile(
            srcResolved,
            '-',
            effectiveMode,
            compilerFlags,
            { stage: 'assembly', cwd, environ }
          );
          if (exitCode !== 0) return exitCode;
        } else {
          const outResolved = outputFile
            ? resolve(outputFile)
            : srcResolved.replace(/\.(c|cpp|cc|cxx)$/, '.s');
          ensureParentDir(outResolved);
          const exitCode = await toolchain.compile(
            srcResolved,
            outResolved,
            effectiveMode,
            compilerFlags,
            { stage: 'assembly', cwd, environ }
          );
          if (exitCode !== 0) return exitCode;
        }
      }
      return 0;
    }

    // Stage: Compile-only (-c)
    if (stage === 'compile') {
      if (sources.length === 0) {
        if (typeof write === 'function') write(`${cmd || 'gcc'}: fatal error: no input files\r\n`);
        return 1;
      }

      for (const src of sources) {
        const srcResolved = resolve(src);
        const objResolved = outputFile
          ? resolve(outputFile)
          : srcResolved.replace(/\.(c|cpp|cc|cxx)$/, '.o');

        ensureParentDir(objResolved);

        const exitCode = await toolchain.compile(
          srcResolved,
          objResolved,
          effectiveMode,
          compilerFlags,
          { stage: 'compile', cwd, environ }
        );

        if (exitCode !== 0) return exitCode;

        if (typeof toolchain.getFile === 'function') {
          const objData = toolchain.getFile(objResolved);
          if (objData && !vfsExists(vfs, objResolved)) {
            vfsWriteFile(vfs, objResolved, objData);
          }
        }
      }

      return 0;
    }

    // Stage: Full Compile & Link (default when neither -E, -S, nor -c is given)
    const generatedObjects = [...objects.map(resolve)];

    for (const src of sources) {
      const srcResolved = resolve(src);
      const objResolved = srcResolved.replace(/\.(c|cpp|cc|cxx)$/, '.o');
      ensureParentDir(objResolved);

      const exitCode = await toolchain.compile(
        srcResolved,
        objResolved,
        effectiveMode,
        compilerFlags,
        { stage: 'compile', cwd, environ }
      );

      if (exitCode !== 0) return exitCode;

      if (typeof toolchain.getFile === 'function') {
        const objData = toolchain.getFile(objResolved);
        if (objData && !vfsExists(vfs, objResolved)) {
          vfsWriteFile(vfs, objResolved, objData);
        }
      }

      if (vfsExists(vfs, objResolved) || (toolchain.getFile && toolchain.getFile(objResolved))) {
        generatedObjects.push(objResolved);
      }
    }

    // Link step
    if (generatedObjects.length === 0) {
      if (typeof write === 'function') write(`${cmd || 'gcc'}: fatal error: no input files\r\n`);
      return 1;
    }

    const finalOutput = resolve(outputFile || 'a.out');
    ensureParentDir(finalOutput);
    const linkExitCode = await toolchain.link(generatedObjects, finalOutput, linkerFlags);

    if (linkExitCode === 0 && typeof toolchain.getFile === 'function') {
      const binData = toolchain.getFile(finalOutput);
      if (binData && !vfsExists(vfs, finalOutput)) {
        vfsWriteFile(vfs, finalOutput, binData);
      }
    }

    return linkExitCode;
  } finally {
    if (toolchain && prevHostWrite !== undefined) {
      toolchain.hostWrite = prevHostWrite;
    }
  }
}

/**
 * Direct linker driver for wasm-ld.
 */
export async function executeLdCommand({
  cmd = 'wasm-ld',
  args = [],
  cwd = '/workspace',
  environ = {},
  vfs,
  toolchain,
  write,
}) {
  if (toolchain && typeof toolchain.init === 'function') {
    await toolchain.init();
  }
  const prevHostWrite = toolchain ? toolchain.hostWrite : null;
  if (toolchain && typeof write === 'function') {
    toolchain.hostWrite = write;
  }
  try {
    if (toolchain && typeof toolchain.runLld === 'function') {
      return await toolchain.runLld(cmd, args, { cwd, environ });
    }
    return 0;
  } finally {
    if (toolchain && prevHostWrite !== undefined) {
      toolchain.hostWrite = prevHostWrite;
    }
  }
}

/**
 * Unified executor for multicall utilities (ar, ranlib, nm, objdump, size, strings, cxxfilt, readobj).
 */
export async function executeToolCommand({
  cmd,
  args = [],
  cwd = '/workspace',
  environ = {},
  vfs,
  toolchain,
  write,
}) {
  if (toolchain && typeof toolchain.init === 'function') {
    await toolchain.init();
  }
  const prevHostWrite = toolchain ? toolchain.hostWrite : null;
  if (toolchain && typeof write === 'function') {
    toolchain.hostWrite = write;
  }
  try {
    if (toolchain && typeof toolchain.runTool === 'function') {
      return await toolchain.runTool(cmd, args, { cwd, environ });
    }
    return 0;
  } finally {
    if (toolchain && prevHostWrite !== undefined) {
      toolchain.hostWrite = prevHostWrite;
    }
  }
}
