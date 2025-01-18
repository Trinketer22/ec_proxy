import "../helpers/ec_helpers.tolk";
import "../helpers/jetton-utils.tolk";

global acceptEmpty: int;

@inline
fun getEcId() {
	return getContractData().beginParse().preloadUint(32);
}

@inline
fun getOwner() {
	return getContractData().beginParse().skipBits(32).loadAddress();
}

@inline
fun loadData() {
	var ds = getContractData().beginParse();
	var (inited, curId, owner, minter, acceptEmptyParsed, forwardAmount, salt) = (
		ds.loadUint(1),
		ds.loadUint(32),
		ds.loadAddress(),
		ds.loadAddress(),
                ds.loadUint(1),
		ds.loadCoins(),
		ds.loadUint(SALT_SIZE)
	);

	ds.assertEndOfSlice();
        acceptEmpty = acceptEmptyParsed;
	return (inited, curId, owner, minter, forwardAmount, salt);
}

@inline
fun updateProxyOptions(newForwardAmount: int, newAcceptEmpty: int) {
	var ds   = getContractData().beginParse();
	var head = ds.loadBits(1 + 32 + 267 + 267);
        ds.skipBits(1);
	ds.loadCoins();

	var tail = ds.loadBits(SALT_SIZE);

	setContractData(beginCell().storeSlice(head)
                                   .storeUint(newAcceptEmpty, 1)
				   .storeCoins(newForwardAmount)
				   .storeSlice(tail)
			.endCell());
					
}

@inline
fun saveData(inited: int, curId: int, owner: slice, minter: slice, forwardAmount: int, salt: int) {
	setContractData(beginCell().storeUint(inited, 1)
				   .storeUint(curId, 32)
				   .storeSlice(owner)
				   .storeSlice(minter)
                                   .storeUint(acceptEmpty, 1)
				   .storeCoins(forwardAmount)
				   .storeUint(salt, SALT_SIZE)
		        .endCell());
}
