CC ?= clang
LD ?= wasm-ld
SYSROOT ?= ../../public/sysroot
OPT ?= wasm-opt

CFLAGS = --target=wasm32-wasip1 -I. -O2 -Wall -Wextra -Wno-unused-parameter
LDFLAGS = --no-entry --export-dynamic --allow-undefined -lc

all: memfs.wasm

memfs.wasm: memfs.o stb_sprintf.o
	$(LD) $(LDFLAGS) -o $@ $^
	@if command -v $(OPT) >/dev/null 2>&1; then \
		$(OPT) -O3 $@ -o $@; \
	fi

memfs.o: memfs.c
	$(CC) $(CFLAGS) -c -o $@ $<

stb_sprintf.o: stb_sprintf.h
	$(CC) $(CFLAGS) -DSTB_SPRINTF_IMPLEMENTATION -x c -c -o $@ $<

clean:
	rm -f *.o memfs.wasm

.PHONY: all clean
