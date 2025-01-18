import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, toNano, Sender, SendMode, Dictionary, DictionaryKey, DictionaryValue } from '@ton/core';
import { Ops } from './Constants';
import { sha256_sync } from '@ton/crypto';

type JettonMinterContentOffchain = {
    type: 'offchain',
    uri: string
}
type OnChainContentData = 'uri' | 'name' | 'description' | 'image' | 'image_data' | 'symbol' | 'decimals' | 'amount_style' | 'render_type' | 'currency' | 'game';

type JettonMinterContentOnChain = {
    type: 'onchain',
    data: Partial<Record<OnChainContentData, string>>
}
export type JettonMinterContent = JettonMinterContentOffchain | JettonMinterContentOnChain;

export type MinterConfig = {
    curId: bigint,
    admin: Address
    walletCode: Cell,
    content: Cell
};


export function OnChainString(): DictionaryValue<string> {
    return {
        serialize(src, builder) {
            builder.storeRef(beginCell().storeUint(0, 8).storeStringTail(src));
        },
        parse(src) {
            const sc  = src.loadRef().beginParse();
            const tag = sc.loadUint(8);
            if(tag == 0) {
                return sc.loadStringTail();
            } else if(tag == 1) {
                // Not really tested, but feels like it should work
                const chunkDict = Dictionary.loadDirect(Dictionary.Keys.Uint(32), Dictionary.Values.Cell(), sc);
                return chunkDict.values().map(x => x.beginParse().loadStringTail()).join('');

            } else {
                throw Error(`Prefix ${tag} is not supported yet!`);
            }
        }
    }
}
export function jettonContentToCell(content: JettonMinterContent) {
    if(content.type == 'offchain') {
        return beginCell()
            .storeUint(1, 8)
            .storeStringRefTail(content.uri) //Snake logic under the hood
            .endCell();
    }
    let keySet = new Set(['uri' , 'name' , 'description' , 'image' , 'image_data' , 'symbol' , 'decimals' , 'amount_style' , 'render_type' , 'currency' , 'game']);
    let contentDict = Dictionary.empty(Dictionary.Keys.Buffer(32), OnChainString());

    for (let contentKey in content.data) {
        if(keySet.has(contentKey)) {
            contentDict.set(
                sha256_sync(contentKey),
                content.data[contentKey as OnChainContentData]!
            );
        }
    }
    return beginCell().storeUint(0, 8).storeDict(contentDict).endCell();
}

export function minterConfigToCell(config: MinterConfig): Cell {
    return beginCell().storeAddress(config.admin)
                      .storeUint(config.curId, 32)
                      .storeRef(config.walletCode)
                      .storeRef(config.content)
           .endCell();
}

export class Minter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Minter(address);
    }

    static createFromConfig(config: MinterConfig, code: Cell, workchain = 0) {
        const data = minterConfigToCell(config);
        const init = { code, data };
        return new Minter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static deployWalletMessage(owner: Address, excess: Address, acceptEmpty: boolean = true, forwardGas: bigint = 0n, queryId: bigint = 0n) {
        return beginCell().storeUint(Ops.minter.deploy_wallet, 32)
                   .storeUint(queryId, 64)
                   .storeAddress(owner)
                   .storeAddress(excess)
                   .storeBit(acceptEmpty)
                   .storeCoins(forwardGas)
               .endCell();
    }
    async sendDeployWallet(provider: ContractProvider, via: Sender, owner: Address, excess: Address, acceptEmpty: boolean = true,forwardGas: bigint = 0n, value: bigint = toNano('0.15'), queryId: bigint = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Minter.deployWalletMessage(owner, excess, acceptEmpty, forwardGas, queryId)
        });
    }

    /* provide_wallet_address#2c76b973 query_id:uint64 owner_address:MsgAddress include_address:Bool = InternalMsgBody;
    */
    static discoveryMessage(owner: Address, include_address: boolean) {
        return beginCell().storeUint(Ops.minter.provide_wallet_address, 32).storeUint(0, 64) // op, queryId
            .storeAddress(owner).storeBit(include_address)
            .endCell();
    }

    async sendDiscovery(provider: ContractProvider, via: Sender, owner: Address, include_address: boolean, value: bigint = toNano('0.05')) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Minter.discoveryMessage(owner, include_address),
            value: value,
        });
    }

    static changeContentMessage(content: Cell | JettonMinterContent, queryId: number | bigint = 0) {
        let sendContent = content instanceof Cell ? content : jettonContentToCell(content);
        return beginCell()
                .storeUint(Ops.minter.change_content, 32)
                .storeUint(queryId, 64)
                .storeRef(sendContent)
               .endCell();
    }
    async sendChangeContent(provider: ContractProvider, via: Sender, content: Cell | JettonMinterContent, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Minter.changeContentMessage(content, queryId),
            value
        });
    }
    static dropAdminMessage(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Ops.minter.drop_admin, 32)
                .storeUint(queryId, 64)
               .endCell();
    }
    async sendDropAdmin(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Minter.dropAdminMessage(queryId),
            value
        });
    }

    async getState(provider: ContractProvider) {
        return provider.getState();
    }
    async getWalletAddress(provider: ContractProvider, wallet: Address) {
        const { stack } = await provider.get('get_wallet_address', [{type: 'slice', cell: beginCell().storeAddress(wallet).endCell()}]);
        return stack.readAddress();
    }
    async getJettonData(provider: ContractProvider) {
        const { stack } = await provider.get('get_jetton_data', []);
        return {
            supply: stack.readBigNumber(),
            mintable: stack.readBoolean(),
            owner: stack.readAddressOpt(),
            content: stack.readCell(),
            wallet_code: stack.readCell()
        }
    }
    async getJettonDataExtended(provider: ContractProvider) {
        const { stack } = await provider.get('get_jetton_data_extra', []);
        return {
            currencyId: stack.readNumber(),
            supply: stack.readBigNumber(),
            mintable: stack.readBoolean(),
            owner: stack.readAddressOpt(),
            content: stack.readCell(),
            wallet_code: stack.readCell()
        }
    }
}
