import "errors.tolk";

const MY_WORKCHAIN = 0;

@pure
fun isStandardAddress(s: slice): (int, int, int)
    asm "REWRITESTDADDRQ NULLSWAPIFNOT2";

@inline
fun isSameWorkchain(addr: slice): int {
    var (wc: int, _) = parseStandardAddress(addr);
    return wc == MY_WORKCHAIN;
}

@inline
fun checkSameWorkchain(addr: slice) {
    assert(isSameWorkchain(addr)) throw wrong_workchain;
}
