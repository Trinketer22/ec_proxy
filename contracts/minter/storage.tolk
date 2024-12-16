import "../helpers/messages.tolk"
global curId: int;
global owner: slice;
global walletCode: cell;
global content: cell;

@inline
fun loadData() {
	var ds = getContractData().beginParse();
        owner  = ds.loadAddress();
	curId  = ds.loadUint(32);
	walletCode = ds.loadRef();
	content    = ds.loadRef();
}

@inline
fun dropAdmin() {
    var ds = getContractData().beginParse();
    var oldOwner = ds.loadAddress();
    setContractData(beginCell().storeSlice(addrNone()).storeSlice(ds).endCell());
}

@inline
fun updateContent(content: cell) {
	var ds = getContractData().beginParse();
	var walletCode = ds.loadRef();
	var oldContent = ds.loadRef();

	var newData = beginCell().storeSlice(ds)
                                 .storeRef(walletCode)
                                 .storeRef(content)
                      .endCell();

	setContractData(newData);
}
