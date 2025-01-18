import "@stdlib/tvm-dicts"
import "errors.tolk";
import "workchain.tolk"

const SALT_SIZE = 12; // if changed, update calculate_jetton_wallet_data_hash_cheap and pack_jetton_wallet_data_hash_base (data bits size and padding)
const ITERATION_NUM = 128; // should be less than 2^SALT_SIZE-1


@inline
fun calculateJettonWalletAddress(stateInit: cell): slice {
    /*
    https://github.com/ton-blockchain/ton/blob/8a9ff339927b22b72819c5125428b70c406da631/crypto/block/block.tlb#L105
    addr_std$10 anycast:(Maybe Anycast) workchain_id:int8 address:bits256  = MsgAddressInt;
    */
    return beginCell()
    .storeUint(4, 3) // 0b100 = addr_std$10 tag; No anycast
    .storeInt(MY_WORKCHAIN, 8)
    .storeUint(cellHash(stateInit), 256)
    .endCell()
    .beginParse();
}

@inline
fun calculateUserJettonWalletAddress(curId: int, ownerAddress: slice, jettonMasterAddress: slice, jettonWalletCode: cell): slice {
    return calculateJettonWalletAddress(calculateJettonWalletStateInit(curId, ownerAddress, jettonMasterAddress, jettonWalletCode));
}


@pure
fun hashSha256(b: builder): int
    asm "1 PUSHINT HASHEXT_SHA256";

// Trick for gas saving originally created by @NickNekilov
@inline
fun calculateAccountHashCheap(codeHash: int, codeDepth: int, dataHash: int, dataDepth: int): int {
    return beginCell()
        // refs_descriptor:bits8 bits_descriptor:bits8
        .storeUint(
            // refs_descriptor: ref_count + ((exotic? & 1) * 8) + (mask * 32)
            // we have 2 refs (code+data), non-exotic, zero mask
            (2 << 16) |
            // bits_descriptor: floor(bit_count/8) + ceil(bit_count/8)
            // we have 5 bit of data, bits_descriptor = 0 + 1 = 1
            (1 << 8) |
            // data: actual data: (split_depth, special,code, data, library) and also 3 bit for ceil number of bits
            // [0b00110] + [0b100]
            0x34,
            24
        )
        //depth descriptors
        .storeUint(codeDepth, 16)
        .storeUint(dataDepth, 16)
        // ref hashes
        .storeUint(codeHash, 256)
        .storeUint(dataHash, 256)
        .hashSha256();
}

@inline
fun calculateAccountHashCheapWithBaseBuilder(baseBuilder: builder, dataHash: int): int {
    // debugPrint(baseBuilder.getBuilderBitsCount());
    return baseBuilder
           .storeUint(dataHash, 256)
           .hashSha256();
}

@inline
fun packJettonWalletDataBuilderBase(curId: int, ownerAddress: slice, jettonMasterAddress: slice): builder {
    return beginCell()
        .storeUint(0, 1)
        .storeUint(curId, 32)
        .storeSlice(ownerAddress)
        .storeSlice(jettonMasterAddress)
        .storeUint(0, 1)
        .storeCoins(0);
}

@inline
fun packJettonWalletDataHashBase(walletDataBase: builder): builder {
    return beginCell()
    // refs_descriptor:bits8 bits_descriptor:bits8
        .storeUint(
            // refs_descriptor: ref_count + ((exotic? & 1) * 8) + (mask * 32)
            // we have 0 refs , non-exotic, zero mask
            //0 |
            // bits_descriptor: floor(bit_count/8) + ceil(bit_count/8)
            // we have 1 + 32 + 267 + 267 + 1 + 4 + 12 = 584 bit of data, bits_descriptor = 73 + 73 = 146
            146,
            16
        )
    //depth descriptors
        .storeBuilder(walletDataBase);
}

@inline
fun calculateAccountHashBaseSlice(codeHash: int, codeDepth: int, dataDepth: int): builder {
    return beginCell()
    // refs_descriptor:bits8 bits_descriptor:bits8
        .storeUint(
            // refs_descriptor: ref_count + ((exotic? & 1) * 8) + (mask * 32)
            // we have 2 refs (code+data), non-exotic, zero mask
            (2 << 16) |
            // bits_descriptor: floor(bit_count/8) + ceil(bit_count/8)
            // we have 5 bit of data, bits_descriptor = 0 + 1 = 1
            (1 << 8) |
            // data: actual data: (split_depth, special,code, data, library) and also 3 bit for ceil number of bits
            // [0b00110] + [0b100]
            0x34,
            24
        )
    //depth descriptors
        .storeUint(codeDepth, 16)
        .storeUint(dataDepth, 16)
    // ref hashes
        .storeUint(codeHash, 256);
}

@inline
fun calculateJettonWalletDataHashCheap(base: builder, salt: int): int {
    return base
           // salt 9 bits, no trailing bits needed
           .storeUint(salt, SALT_SIZE)
           .hashSha256();
}

@inline
fun calculateJettonWalletPropertiesCheap(curId: int, ownerAddress: slice, jettonMasterAddress: slice, jettonWalletCode: cell): [cell, int] {
    /*
    https://github.com/ton-blockchain/ton/blob/8a9ff339927b22b72819c5125428b70c406da631/crypto/block/block.tlb#L144
    _ split_depth:(Maybe (## 5)) special:(Maybe TickTock)
    code:(Maybe ^Cell) data:(Maybe ^Cell)
    library:(Maybe ^Cell) = StateInit;
  */
    var stop: int = false;
    var minDistance: int = 0xffff;
    var salt: int = -1;
    var minSalt: int = 0;
    var (_, ownerPrefix: int) = parseStandardAddress(ownerAddress);
    ownerPrefix = ownerPrefix >> (256 - 4);
    var jettonWalletDataBase: builder = packJettonWalletDataBuilderBase(curId, ownerAddress, jettonMasterAddress);
    var jettonWalletDataHashBase: builder = packJettonWalletDataHashBase(jettonWalletDataBase);
    var jettonWalletAccountHashBase: builder = calculateAccountHashBaseSlice(cellHash(jettonWalletCode), getCellDepth(jettonWalletCode), 0);

    do {
        salt += 1;
        var dataHash: int = calculateJettonWalletDataHashCheap(jettonWalletDataHashBase, salt);
        var accountHash: int = calculateAccountHashCheapWithBaseBuilder(jettonWalletAccountHashBase, dataHash);
        var walletPrefix: int = accountHash >> (256 - 4);
        var distance: int = walletPrefix ^ ownerPrefix;
        if (distance < minDistance) {
            minDistance = distance;
            minSalt = salt;
        }
        stop = (salt == ITERATION_NUM) | (minDistance == 0);
    } while (!stop);
    var stateInit: cell = beginCell()
        .storeUint(0, 2) // 0b00 - No split_depth; No special
        .storeMaybeRef(jettonWalletCode)
        .storeMaybeRef(jettonWalletDataBase.storeUint(minSalt, SALT_SIZE).endCell())
        .storeUint(0, 1) // Empty libraries
        .endCell();
    return [stateInit, minSalt];
}


@inline
fun calculateJettonWalletStateInit(curId: int, ownerAddress: slice, jettonMasterAddress: slice, jettonWalletCode: cell): cell {
    var [stateInit: cell, salt: int] = calculateJettonWalletPropertiesCheap(curId, ownerAddress, jettonMasterAddress, jettonWalletCode);
    return stateInit;
}


/*
@inline
fun calculateUserJettonWalletAddress(curId: int, ownerAddress: slice, jettonMasterAddress: slice, jettonWalletCode: cell): slice {
    return calculateJettonWalletAddress(calculateJettonWalletStateInit(curId, ownerAddress, jettonMasterAddress, jettonWalletCode)).endCell().beginParse();
}
*/

@inline
fun checkEitherForwardPayload(self: slice) {
    if (self.preloadUint(1)) {
        // forward_payload in ref
        var (remainBits: int, remainRefs: int) = getRemainingBitsAndRefsCount(self);
        assert((remainRefs == 1) & (remainBits == 1), invalid_message); // we check that there is no excess in the slice
    }
    // else forward_payload in slice - arbitrary bits and refs
    return self;
}

@inline
fun setTokenSnakeMetadataEntry(mutate self: cell, key: int, value: slice) {
    self.uDictSetRef(256, key, beginCell().storeUint(0, 8).storeSlice(value).endCell());
    return self;
}

@inline
fun createTokenOnchainMetadata(content: cell) {
    return beginCell().storeUint(0, 8).storeDict(content).endCell();
}
