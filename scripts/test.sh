#!/usr/bin/env bash
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DIST_DIR="${REPO_ROOT}/dist"
LLVM_BOX_WASM="${DIST_DIR}/llvm-box.wasm"
SYSROOT_ARCHIVE="${DIST_DIR}/sysroot.tar.gz"

echo "=============================================="
echo "    WASI Toolchain Test Suite (clang-wasi)    "
echo "=============================================="

# 1. Validate distribution artifacts
echo "=== Step 1: Checking release artifacts in ${DIST_DIR} ==="
MISSING=0
for f in "${LLVM_BOX_WASM}" "${SYSROOT_ARCHIVE}"; do
  if [ ! -f "${f}" ]; then
    echo "[-] Missing artifact: ${f}" >&2
    MISSING=1
  else
    echo "[+] Found artifact: $(basename "${f}") ($(du -h "${f}" | cut -f1))"
  fi
done

if [ "${MISSING}" -ne 0 ]; then
  echo "Error: Required distribution artifacts are missing. Run ./scripts/build.sh first." >&2
  exit 1
fi

# 2. Detect WASI runtime (wasmtime or Node.js)
echo "=== Step 2: Detecting WASI runtime ==="
if command -v wasmtime &> /dev/null; then
  echo "[+] Detected runtime: wasmtime ($(wasmtime --version | head -n 1))"
  run_wasi() {
    wasmtime run "$@"
  }
elif command -v node &> /dev/null; then
  echo "[+] Detected runtime: Node.js node:wasi ($(node --version)) via scripts/wasi-run.js"
  run_wasi() {
    node "${SCRIPT_DIR}/wasi-run.js" "$@"
  }
else
  echo "Error: No supported WASI runtime found." >&2
  echo "Please install either 'wasmtime' or 'node' (>= 18)." >&2
  exit 1
fi

# 3. Setup temporary workspace and unpack sysroot.tar.gz
TEST_TMP="$(mktemp -d /tmp/clang-wasi-test.XXXXXX)"
trap 'rm -rf "${TEST_TMP}"' EXIT
mkdir -p "${TEST_TMP}/workspace" "${TEST_TMP}/sysroot"

echo "=== Step 3: Unpacking standalone sysroot.tar.gz ==="
tar -xf "${SYSROOT_ARCHIVE}" -C "${TEST_TMP}/sysroot"
echo "[+] Standalone sysroot extracted successfully."

# 4. Test toolchain version identification
echo "=== Step 4: Testing compiler and linker startup ==="
CLANG_OUT="$(run_wasi "${CLANG_WASM}" -- --version)"
CLANG_VER="$(echo "${CLANG_OUT}" | head -n 1)"
echo "[+] Clang Version: ${CLANG_VER}"
LLD_OUT="$(run_wasi "${LLD_WASM}" -- -flavor wasm --version)"
LLD_VER="$(echo "${LLD_OUT}" | head -n 1)"
echo "[+] LLD Version:   ${LLD_VER}"

# 5. Test C compilation and execution
echo "=== Step 5: Testing C compilation and execution ==="
cat << 'EOF' > "${TEST_TMP}/workspace/hello.c"
#include <stdio.h>

int main(void) {
    printf("Hello from WASI Clang 19!\n");
    return 0;
}
EOF

echo "  -> Compiling hello.c with llvm-box (clang)..."
run_wasi \
  --dir="${TEST_TMP}/workspace::/workspace" \
  --dir="${TEST_TMP}/sysroot::/sysroot" \
  "${LLVM_BOX_WASM}" -- clang \
  --target=wasm32-wasip1 \
  --sysroot=/sysroot \
  -resource-dir=/sysroot/lib/clang/19 \
  -c /workspace/hello.c \
  -o /workspace/hello.o

if [ ! -s "${TEST_TMP}/workspace/hello.o" ]; then
  echo "[-] Error: C compilation produced empty or missing object file." >&2
  exit 1
fi
echo "[+] C object file generated."

echo "  -> Linking hello.o with llvm-box (wasm-ld)..."
run_wasi \
  --dir="${TEST_TMP}/workspace::/workspace" \
  --dir="${TEST_TMP}/sysroot::/sysroot" \
  "${LLVM_BOX_WASM}" -- wasm-ld \
  -flavor wasm \
  /sysroot/lib/wasm32-wasip1/crt1.o \
  /workspace/hello.o \
  -L/sysroot/lib/wasm32-wasip1 \
  -L/sysroot/lib/clang/19/lib/wasm32-unknown-wasip1 \
  -lc \
  -lclang_rt.builtins \
  -o /workspace/hello.wasm

if [ ! -s "${TEST_TMP}/workspace/hello.wasm" ]; then
  echo "[-] Error: C linking produced empty or missing wasm binary." >&2
  exit 1
fi
echo "[+] C wasm binary linked."

echo "  -> Executing hello.wasm..."
C_OUTPUT="$(run_wasi "${TEST_TMP}/workspace/hello.wasm")"
echo "  -> Program output: ${C_OUTPUT}"
if [ "${C_OUTPUT}" != "Hello from WASI Clang 19!" ]; then
  echo "[-] Error: Unexpected C output: '${C_OUTPUT}'" >&2
  exit 1
fi
echo "[PASS] C compilation, linking, and execution verified!"

# 6. Test C++ compilation and execution
echo "=== Step 6: Testing C++ compilation and execution ==="
cat << 'EOF' > "${TEST_TMP}/workspace/hello.cpp"
#include <iostream>
#include <vector>
#include <string>

int main() {
    std::vector<std::string> words = {"Hello", "from", "WASI", "C++19!"};
    for (size_t i = 0; i < words.size(); ++i) {
        std::cout << words[i] << (i + 1 < words.size() ? " " : "\n");
    }
    return 0;
}
EOF

echo "  -> Compiling hello.cpp with llvm-box (clang++)..."
run_wasi \
  --dir="${TEST_TMP}/workspace::/workspace" \
  --dir="${TEST_TMP}/sysroot::/sysroot" \
  "${LLVM_BOX_WASM}" -- clang++ \
  --target=wasm32-wasip1 \
  --sysroot=/sysroot \
  -resource-dir=/sysroot/lib/clang/19 \
  -fno-exceptions \
  -c /workspace/hello.cpp \
  -o /workspace/hello_cpp.o

if [ ! -s "${TEST_TMP}/workspace/hello_cpp.o" ]; then
  echo "[-] Error: C++ compilation produced empty or missing object file." >&2
  exit 1
fi
echo "[+] C++ object file generated."

echo "  -> Linking hello_cpp.o with llvm-box (wasm-ld)..."
run_wasi \
  --dir="${TEST_TMP}/workspace::/workspace" \
  --dir="${TEST_TMP}/sysroot::/sysroot" \
  "${LLVM_BOX_WASM}" -- wasm-ld \
  -flavor wasm \
  /sysroot/lib/wasm32-wasip1/crt1.o \
  /workspace/hello_cpp.o \
  -L/sysroot/lib/wasm32-wasip1 \
  -L/sysroot/lib/clang/19/lib/wasm32-unknown-wasip1 \
  -lc++ \
  -lc++abi \
  -lc \
  -lclang_rt.builtins \
  -o /workspace/hello_cpp.wasm

if [ ! -s "${TEST_TMP}/workspace/hello_cpp.wasm" ]; then
  echo "[-] Error: C++ linking produced empty or missing wasm binary." >&2
  exit 1
fi
echo "[+] C++ wasm binary linked."

echo "  -> Executing hello_cpp.wasm..."
CPP_OUTPUT="$(run_wasi "${TEST_TMP}/workspace/hello_cpp.wasm")"
echo "  -> Program output: ${CPP_OUTPUT}"
if [ "${CPP_OUTPUT}" != "Hello from WASI C++19!" ]; then
  echo "[-] Error: Unexpected C++ output: '${CPP_OUTPUT}'" >&2
  exit 1
fi
echo "[PASS] C++ compilation, linking, and execution verified!"

# 7. Test standalone WasiHost pure JavaScript runner
if command -v node &> /dev/null; then
  echo "=== Step 7: Testing standalone WasiHost in-memory VFS runner ==="
  node "${SCRIPT_DIR}/test-wasi-host.js"
fi

echo "=============================================="
echo "    All WASI toolchain tests passed!          "
echo "=============================================="

