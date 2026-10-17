#!/usr/bin/env bash
set -euo pipefail
umask 022

LLVM_VERSION="19.1.0"
WASI_SDK_VERSION="29.0"
WASI_SDK_MAJOR="${WASI_SDK_VERSION%%.*}"

echo "=== 1. Fetching wasi-sdk ==="
if [ ! -d "wasi-sdk" ] || [ ! -f "wasi-sdk/share/cmake/wasi-sdk-p1.cmake" ] || [ ! -x "wasi-sdk/bin/clang" ]; then
  echo "wasi-sdk not found or incomplete. Downloading wasi-sdk-${WASI_SDK_VERSION}..."
  rm -rf wasi-sdk "wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux" "wasi-sdk-tmp"
  mkdir -p wasi-sdk-tmp
  curl -sSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_MAJOR}/wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux.tar.gz" | tar -xz -C wasi-sdk-tmp
  mv wasi-sdk-tmp/"wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux" wasi-sdk
  rm -rf wasi-sdk-tmp
  echo "wasi-sdk installed successfully."
else
  echo "wasi-sdk is already installed and valid. Skipping download."
fi
export WASI_SDK_PATH="$(pwd)/wasi-sdk"

echo "=== 2. Cloning LLVM ${LLVM_VERSION} ==="
if [ ! -d "llvm-project" ] || ! git -C llvm-project rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Cloning llvm-project (branch llvmorg-${LLVM_VERSION})..."
  rm -rf llvm-project
  git clone --depth 1 --branch "llvmorg-${LLVM_VERSION}" https://github.com/llvm/llvm-project.git
else
  echo "llvm-project git repository already exists. Skipping clone."
fi

PATCH_FILE="$(pwd)/scripts/patches/llvm-wasi-${LLVM_VERSION}.patch"
if [ -f "${PATCH_FILE}" ]; then
  echo "=== Checking WASI patch on llvm-project ==="
  if git -C llvm-project apply --reverse --check "${PATCH_FILE}" >/dev/null 2>&1; then
    echo "WASI patch is already applied to llvm-project. Skipping."
  elif git -C llvm-project apply --check "${PATCH_FILE}" >/dev/null 2>&1; then
    echo "Applying WASI patch (${PATCH_FILE}) to llvm-project..."
    git -C llvm-project apply "${PATCH_FILE}"
    echo "WASI patch applied successfully."
  else
    echo "Error: WASI patch cannot be cleanly applied to llvm-project, nor is it already applied." >&2
    echo "The repository may be in a dirty or conflicting state. Please check 'git -C llvm-project status'." >&2
    exit 1
  fi
else
  echo "Warning: Patch file not found at ${PATCH_FILE}."
fi

echo "=== 3. Stage 1: Build Host TableGen ==="
if [ ! -f "build-native/build.ninja" ]; then
  echo "Configuring build-native..."
  cmake -B build-native -S llvm-project/llvm \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TARGETS_TO_BUILD="WebAssembly"
fi

if [ -x "build-native/bin/llvm-tblgen" ] && [ -x "build-native/bin/clang-tblgen" ]; then
  echo "Host TableGen binaries already exist. Checking for incremental updates..."
fi
ninja -C build-native llvm-tblgen clang-tblgen

echo "=== 4. Stage 2: Cross-compile Clang and LLD to WASI ==="
if [ ! -f "build-wasi/build.ninja" ]; then
  echo "Configuring build-wasi..."
  cmake -B build-wasi -S llvm-project/llvm \
    -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="${WASI_SDK_PATH}/share/cmake/wasi-sdk-p1.cmake" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_HOST_TRIPLE="wasm32-wasip1" \
    -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TABLEGEN="$(pwd)/build-native/bin/llvm-tblgen" \
    -DCLANG_TABLEGEN="$(pwd)/build-native/bin/clang-tblgen" \
    -DLLVM_ENABLE_THREADS=OFF \
    -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_BUILD_STATIC=ON \
    -DCMAKE_C_FLAGS="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID" \
    -DCMAKE_CXX_FLAGS="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,--stack-first -Wl,-z,stack-size=16777216 -Wl,--initial-memory=67108864 -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid"
fi

echo "Building WASI targets (clang, lld)..."
ninja -C build-wasi clang lld

echo "=== 5. Post-processing Binaries & Packaging ==="
mkdir -p dist
chmod 755 dist

process_binary() {
  local src="$1"
  local dest="$2"
  local name="$3"

  # Update if destination does not exist or source is newer than destination
  if [ ! -f "${dest}" ] || [ "${src}" -nt "${dest}" ]; then
    echo "Processing ${name}..."
    rm -f "${dest}.tmp" "${dest}.opt"
    cp -L "${src}" "${dest}.tmp"
    if command -v wasm-opt &> /dev/null; then
      echo "Optimizing ${name} with wasm-opt..."
      wasm-opt -O2 "${dest}.tmp" -o "${dest}.opt"
      mv "${dest}.opt" "${dest}"
      rm -f "${dest}.tmp"
    else
      mv "${dest}.tmp" "${dest}"
    fi
    chmod 644 "${dest}"
    echo "${name} ready at ${dest}."
  else
    echo "${dest} is up to date."
  fi
}

process_binary "build-wasi/bin/clang" "dist/clang.wasm" "clang"
process_binary "build-wasi/bin/lld" "dist/lld.wasm" "lld"

# Build memfs.wasm (WASI in-memory filesystem bridge for browser environments)
MEMFS_DEST="dist/memfs.wasm"
needs_memfs_rebuild() {
  if [ ! -f "${MEMFS_DEST}" ]; then
    return 0
  fi
  if [ "src/memfs/memfs.c" -nt "${MEMFS_DEST}" ] || [ "src/memfs/stb_sprintf.h" -nt "${MEMFS_DEST}" ]; then
    return 0
  fi
  return 1
}

if needs_memfs_rebuild; then
  echo "=== Building modern memfs.wasm ==="
  mkdir -p build-memfs

  "${WASI_SDK_PATH}/bin/clang" --target=wasm32-wasip1 \
    --sysroot="${WASI_SDK_PATH}/share/wasi-sysroot" \
    -Isrc/memfs -O2 -Wall -Wextra -Wno-unused-parameter \
    -c src/memfs/memfs.c -o build-memfs/memfs.o

  "${WASI_SDK_PATH}/bin/clang" --target=wasm32-wasip1 \
    --sysroot="${WASI_SDK_PATH}/share/wasi-sysroot" \
    -DSTB_SPRINTF_IMPLEMENTATION -x c -O2 \
    -c src/memfs/stb_sprintf.h -o build-memfs/stb_sprintf.o

  rm -f "${MEMFS_DEST}.tmp" "${MEMFS_DEST}.opt"
  "${WASI_SDK_PATH}/bin/wasm-ld" \
    -L"${WASI_SDK_PATH}/share/wasi-sysroot/lib/wasm32-wasip1" \
    --no-entry --export-dynamic --allow-undefined -lc \
    build-memfs/memfs.o build-memfs/stb_sprintf.o -o "${MEMFS_DEST}.tmp"

  if command -v wasm-opt >/dev/null 2>&1; then
    echo "Optimizing memfs.wasm with wasm-opt -O3..."
    wasm-opt -O3 "${MEMFS_DEST}.tmp" -o "${MEMFS_DEST}.opt"
    mv "${MEMFS_DEST}.opt" "${MEMFS_DEST}"
    rm -f "${MEMFS_DEST}.tmp"
  else
    mv "${MEMFS_DEST}.tmp" "${MEMFS_DEST}"
  fi
  chmod 644 "${MEMFS_DEST}"
  echo "memfs.wasm built and optimized successfully."
else
  echo "${MEMFS_DEST} is up to date."
fi

# Assemble complete sysroot.tar (headers, static libraries, and compiler builtins)
SYSROOT_TAR="dist/sysroot.tar"
SYSROOT_SRC="${WASI_SDK_PATH}/share/wasi-sysroot"
CLANG_HEADERS_SRC="llvm-project/clang/lib/Headers"

needs_sysroot_rebuild() {
  if [ ! -f "${SYSROOT_TAR}" ]; then
    return 0
  fi
  if [ "${SYSROOT_SRC}" -nt "${SYSROOT_TAR}" ]; then
    return 0
  fi
  return 1
}

if needs_sysroot_rebuild; then
  echo "Assembling sysroot archive (${SYSROOT_TAR})..."
  STAGING_DIR="dist/.sysroot_staging"
  rm -rf "${STAGING_DIR}" "${SYSROOT_TAR}.tmp"
  mkdir -p "${STAGING_DIR}/include" "${STAGING_DIR}/lib"

  # Single-threaded WASI Preview 1 headers & libraries
  cp -r "${SYSROOT_SRC}/include/wasm32-wasip1" "${STAGING_DIR}/include/"
  cp -r "${SYSROOT_SRC}/include/wasm32-wasi" "${STAGING_DIR}/include/"
  if [ -d "${SYSROOT_SRC}/include/c++" ]; then
    cp -r "${SYSROOT_SRC}/include/c++" "${STAGING_DIR}/include/"
  fi

  cp -r "${SYSROOT_SRC}/lib/wasm32-wasip1" "${STAGING_DIR}/lib/"
  cp -r "${SYSROOT_SRC}/lib/wasm32-wasi" "${STAGING_DIR}/lib/"

  # Provide root-level include symlinks for classic wasm-clang runner compatibility
  for item in "${STAGING_DIR}/include/wasm32-wasip1"/*; do
    base="$(basename "$item")"
    if [ ! -e "${STAGING_DIR}/include/${base}" ]; then
      ln -s "wasm32-wasip1/${base}" "${STAGING_DIR}/include/${base}"
    fi
  done

  # Provide root-level lib symlinks for classic wasm-clang runner compatibility
  for item in "${STAGING_DIR}/lib/wasm32-wasip1"/*; do
    base="$(basename "$item")"
    if [ ! -e "${STAGING_DIR}/lib/${base}" ]; then
      ln -s "wasm32-wasip1/${base}" "${STAGING_DIR}/lib/${base}"
    fi
  done

  # Built-in Clang headers (required at runtime by clang -cc1)
  mkdir -p "${STAGING_DIR}/lib/clang/19/include"
  cp -r "${CLANG_HEADERS_SRC}"/* "${STAGING_DIR}/lib/clang/19/include/"

  # Compiler-rt builtins for wasm32-wasip1 and wasm32-wasi
  BUILTIN_WASIP1="$(find "${WASI_SDK_PATH}/lib/clang" -name "libclang_rt.builtins.a" | grep "wasm32-unknown-wasip1" | head -n 1 || true)"
  if [ -n "${BUILTIN_WASIP1}" ] && [ -f "${BUILTIN_WASIP1}" ]; then
    mkdir -p "${STAGING_DIR}/lib/clang/19/lib/wasm32-unknown-wasip1"
    cp "${BUILTIN_WASIP1}" "${STAGING_DIR}/lib/clang/19/lib/wasm32-unknown-wasip1/"
  fi

  BUILTIN_WASI="$(find "${WASI_SDK_PATH}/lib/clang" -name "libclang_rt.builtins.a" | grep "wasm32-unknown-wasi/" | head -n 1 || true)"
  if [ -n "${BUILTIN_WASI}" ] && [ -f "${BUILTIN_WASI}" ]; then
    mkdir -p "${STAGING_DIR}/lib/clang/19/lib/wasm32-unknown-wasi"
    cp "${BUILTIN_WASI}" "${STAGING_DIR}/lib/clang/19/lib/wasm32-unknown-wasi/"
  fi

  tar -cf "${SYSROOT_TAR}.tmp" -C "${STAGING_DIR}" .
  mv "${SYSROOT_TAR}.tmp" "${SYSROOT_TAR}"
  chmod 644 "${SYSROOT_TAR}"
  rm -rf "${STAGING_DIR}"
  echo "sysroot.tar assembled successfully."
else
  echo "${SYSROOT_TAR} is up to date."
fi

# Clean up any legacy unbundled lib directory in dist
rm -rf dist/lib

# Enforce uniform directory and file permissions
chmod 755 dist
chmod 644 dist/*

TAR_FILE="clang-wasi-19.tar.gz"
if [ ! -f "${TAR_FILE}" ] || \
   [ "dist/clang.wasm" -nt "${TAR_FILE}" ] || \
   [ "dist/lld.wasm" -nt "${TAR_FILE}" ] || \
   [ "dist/memfs.wasm" -nt "${TAR_FILE}" ] || \
   [ "dist/sysroot.tar" -nt "${TAR_FILE}" ]; then
  echo "Packaging distribution archive ${TAR_FILE}..."
  rm -f "${TAR_FILE}.tmp"
  tar -czf "${TAR_FILE}.tmp" -C dist .
  mv "${TAR_FILE}.tmp" "${TAR_FILE}"
  chmod 644 "${TAR_FILE}"
  echo "Build complete: ${TAR_FILE}"
else
  echo "Distribution package ${TAR_FILE} is up to date."
fi

