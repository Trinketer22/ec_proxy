import { Address, beginCell, Cell, Slice, Contract, contractAddress, ContractProvider, toNano, Sender, SendMode } from '@ton/core';
import { Ops } from './Constants';
import { ECProxy } from './ECProxy';
import { toNamespacedPath } from 'node:path/win32';

export class ECProxyTest extends ECProxy implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell}) {
        super(address, init);
    }

    static createFromAddress(address: Address) {
        return new ECProxyTest(address);
    }

    static ecTransferMessage(tonAmount: bigint, refund: Address | null, forwardPayload: Cell | Slice | null, queryId: bigint | number = 0) {
        const byRef   = forwardPayload instanceof Cell;
        const transferBody = beginCell().storeUint(Ops.wallet.ec_transfer, 32)
                                        .storeUint(queryId, 64)
                                        .storeCoins(tonAmount)
                                        .storeAddress(refund)
                                        .storeBit(byRef);
        if(byRef) {
            transferBody.storeRef(forwardPayload);
        }
        else if(forwardPayload) {
            transferBody.storeSlice(forwardPayload);
        }
        return transferBody.endCell();
    }
}
