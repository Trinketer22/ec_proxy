import "@stdlib/tvm-dicts";


fun reserveEc(tonValue: int, ec: cell, mode: int): void
	asm "RAWRESERVEX";
@pure
fun getEcValue(mutate self: slice) : int
	asm( -> 1 0) "LDVARUINT32";

fun dumpStk(): void
	asm "DUMPSTK";

@pure
fun storeEcValue(mutate self: builder, x: int) : self
	asm "STVARUINT32";


@inline
@pure
fun packEcValue(id: int, x: int) : cell {
	var ecDict: cell  = createEmptyDict();
	var ecData: slice = beginCell().storeEcValue(x).endCell().beginParse();
	ecDict.uDictSet(32, id, ecData);
	return ecDict;
}
@pure
fun pairSecond<X, Y>(self: [X, Y]): Y
	asm "SECOND";

@pure
@inline
fun getRawEc() : cell {
	var myBalance: [int, cell] = getMyOriginalBalanceWithExtraCurrencies();
	return myBalance.pairSecond();
}

@inline
fun getEcBalance(self: cell, id: int) {
	var res: int   = 0;
	var reserveDict = createEmptyDict();

	var (data, found) = self.uDictGet(32, id);
	if(found) {
		reserveDict.uDictSet(32, id, data);
		res = data.getEcValue();
	} 

	return (res, reserveDict);
}

@inline
fun extractEcAndForwardFee(mutate self: slice): (cell, int) {
	self.loadAddress();
	self.loadCoins();
	var ecDict = self.loadDict();
	self.loadCoins(); // ihr_fee
	return (ecDict, self.loadCoins());
}

