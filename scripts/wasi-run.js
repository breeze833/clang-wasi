#!/usr/bin/env node
const fs = require('fs');
const { WASI } = require('node:wasi');

// Suppress experimental WASI warning
process.removeAllListeners('warning');

const rawArgs = process.argv.slice(2);
const preopens = {};
let wasmFile = null;
let appArgs = [];
let parsingOptions = true;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];

  if (parsingOptions && arg === '--') {
    parsingOptions = false;
    continue;
  }

  if (parsingOptions && arg.startsWith('--dir=')) {
    const part = arg.slice(6);
    const [host, guest] = part.includes('::') ? part.split('::') : [part, part];
    preopens[guest] = host;
  } else if (parsingOptions && arg === '--dir' && i + 1 < rawArgs.length) {
    const part = rawArgs[++i];
    const [host, guest] = part.includes('::') ? part.split('::') : [part, part];
    preopens[guest] = host;
  } else if (!wasmFile) {
    wasmFile = arg;
    if (!parsingOptions) {
      appArgs = rawArgs.slice(i + 1);
      break;
    }
  } else {
    appArgs.push(arg);
  }
}

if (!wasmFile) {
  console.error('Usage: wasi-run.js [--dir=host::guest] <file.wasm> [-- <args...>]');
  process.exit(1);
}

const wasi = new WASI({
  version: 'preview1',
  args: [wasmFile, ...appArgs],
  env: {
    ...process.env,
    PWD: preopens['/workspace'] ? '/workspace' : process.cwd(),
  },
  preopens,
});

try {
  const wasmBytes = fs.readFileSync(wasmFile);
  const wasmModule = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
  const exitCode = wasi.start(instance);
  process.exit(exitCode || 0);
} catch (err) {
  if (err && typeof err.code === 'number') {
    process.exit(err.code);
  }
  if (err && err.message) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
}
