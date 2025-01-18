import { Address, beginCell, Cell, Slice, Contract, contractAddress, ContractProvider, toNano, Sender, SendMode, ContractABI } from '@ton/core';
import { Ops } from './Constants';
import { SendMessageResult } from '@ton/sandbox';

type OptionsWithdrawSpecific = {
        withdrawSpecific: true,
        curId: number,
}
type OptionsWithdrawAll = {
    withdrawSpecific: false
}

export type ProxyOptions = {
    forwardGas: bigint,
    acceptEmptyBody: boolean
}

export type WithdrawOptions = {
    queryId?: bigint,
    value?: bigint
    fromBalance?: bigint
} & (OptionsWithdrawSpecific | OptionsWithdrawAll);
export class ECProxy implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell}) {}

    static createFromAddress(address: Address) {
        return new ECProxy(address);
    }

    static transferMessage(jetton_amount: bigint, to: Address,
                           responseAddress:Address | null,
                           customPayload: Cell | null,
                           forward_ton_amount: bigint,
                           forwardPayload?: Cell | Slice | null) {

        const byRef   = forwardPayload instanceof Cell;
        const transferBody = beginCell().storeUint(Ops.wallet.transfer, 32).storeUint(0, 64) // op, queryId
                          .storeCoins(jetton_amount)
                          .storeAddress(to)
                          .storeAddress(responseAddress)
                          .storeMaybeRef(customPayload)
                          .storeCoins(forward_ton_amount)
                          .storeBit(byRef);

        if(byRef) {
            transferBody.storeRef(forwardPayload);
        }
        else if(forwardPayload) {
            transferBody.storeSlice(forwardPayload);
        }
        return transferBody.endCell();
    }

    async sendTransfer(provider: ContractProvider, via: Sender,
                       value: bigint,
                       jetton_amount: bigint, to: Address,
                       responseAddress:Address,
                       customPayload: Cell | null,
                       forward_ton_amount: bigint,
                       forwardPayload?: Cell | Slice | null) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: ECProxy.transferMessage(jetton_amount, to, responseAddress, customPayload, forward_ton_amount, forwardPayload),
            value:value
        });
    }


    static withdrawExtraECMessage(withdrawSpecific: boolean, to: Address, curId: number, fromBalance: bigint = 0n, queryId: bigint | number = 0) {
        const head =  beginCell()
                        .storeUint(Ops.wallet.withdraw_extra, 32)
                        .storeUint(queryId, 64)
                        .storeBit(withdrawSpecific);
        if(withdrawSpecific) {
            head.storeUint(curId, 32);
        }
        return head.storeCoins(fromBalance).storeAddress(to).endCell();
    }

    async sendWithdrawExtraEC(provider: ContractProvider, via: Sender, to: Address, opts: WithdrawOptions) {
        let curId = 0;
        let fromBalance = opts.fromBalance ?? 0n;
        if(opts.withdrawSpecific) {
            curId = opts.curId;
        }
        await provider.internal(via, {
            value: opts.value ?? toNano('0.05'),
            body: ECProxy.withdrawExtraECMessage(opts.withdrawSpecific, to, curId, fromBalance, opts.queryId ?? 0),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    static updateProxyOptionsMessage(options: Partial<ProxyOptions>, queryId: bigint | number = 0) {
        if(options.forwardGas === undefined && options.acceptEmptyBody === undefined) {
            throw TypeError("No options specified for update");
        }

        const ds = beginCell().storeUint(Ops.wallet.update_proxy_options, 32).storeUint(queryId, 64);

        if(options.forwardGas !== undefined) {
            ds.storeBit(true).storeCoins(options.forwardGas);
        } else {
            ds.storeBit(false);
        }
        if(options.acceptEmptyBody !== undefined) {
            ds.storeBit(true).storeBit(options.acceptEmptyBody)
        } else {
            ds.storeBit(false);
        }
        return ds.endCell();
    }

    async sendUpdateProxyOptions(provider: ContractProvider, via: Sender,
                                  options: Partial<ProxyOptions>,
                                  value: bigint = toNano('0.05'),
                                  queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: ECProxy.updateProxyOptionsMessage(options, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    async getState(provider: ContractProvider) {
        return await provider.getState();
    }
    async getWalletData(provider: ContractProvider) {
        const { stack } = await provider.get('get_wallet_data', []);

        return {
            balance: stack.readBigNumber(),
            owner: stack.readAddress(),
            minter: stack.readAddress(),
            wallet_code: stack.readCell()
        }
    }
    async getWalletDataExtended(provider: ContractProvider) {
        const { stack } = await provider.get('get_wallet_data_extended', []);
        return {
            balance: stack.readBigNumber(),
            inited: stack.readBoolean(),
            currencyId: stack.readNumber(),
            owner: stack.readAddress(),
            minter: stack.readAddress(),
            acceptEmpty: stack.readBoolean(),
            forwardGas: stack.readBigNumber(),
            salt: stack.readBigNumber(),
            wallet_code: stack.readCell()
        }
    }
    async getForwardGas(provider: ContractProvider) {
        const { stack } = await provider.get('get_forward_gas', []);
        return {
            forwardGas: stack.readBigNumber(),
            forwardGasFee: stack.readBigNumber()
        }
    }
}
