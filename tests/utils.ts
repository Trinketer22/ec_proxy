import { Address, beginCell, Cell, Transaction, CurrencyCollection, Dictionary, MessageRelaxed, StateInit, ExternalAddress, Message } from '@ton/core';

const getRandom = (min:number, max:number) => {
    return Math.random() * (max - min) + min;
}

export const getRandomInt = (min: number, max: number) => {
    return Math.round(getRandom(min, max));
}

const testPartial = (cmp: any, match: any) => {
    for (let key in match) {
        if(!(key in cmp)) {
            throw Error(`Unknown key ${key} in ${cmp}`);
        }

        if(match[key] instanceof Address) {
            if(!(cmp[key] instanceof Address)) {
                return false
            }
            if(!(match[key] as Address).equals(cmp[key])) {
                return false
            }
        }
        else if(match[key] instanceof Cell) {
            if(!(cmp[key] instanceof Cell)) {
                return false;
            }
            if(!(match[key] as Cell).equals(cmp[key])) {
                return false;
            }
        }
        else if(match[key] !== cmp[key]){
            return false;
        }
    }
    return true;
}

type JettonTransferNotification = {
    amount: bigint,
    from: Address | null,
    payload: Cell | null
}

export const parseTransferNotification = (body: Cell) => {
    const bs = body.beginParse().skip(64 + 32);
    return {
        amount: bs.loadCoins(),
        from: bs.loadAddressAny(),
        payload: bs.loadUint(1) ? bs.loadRef() : beginCell().storeSlice(bs).endCell()
    }
}

export const testJettonNotification = (body: Cell, match: Partial<JettonTransferNotification>) => {
    const res = parseTransferNotification(body);
    return testPartial(res, match);
}

type DiscoveryResponse = {
    proxy: Address | ExternalAddress | null,
    owner: Address | ExternalAddress | null
}

export const parseDiscovery = (body: Cell) => {
    const bs = body.beginParse().skip(64 + 32);
    let owner: Address | ExternalAddress | null = null;
    const resAddr = bs.loadAddressAny();
    const ownerCell = bs.loadMaybeRef()
    if(ownerCell) {
        owner = ownerCell.beginParse().loadAddressAny();
    }
    return {
        proxy: resAddr,
        owner
    }
}

export const testDiscovery = (body: Cell, match: Partial<DiscoveryResponse>) => {
    const res = parseDiscovery(body);
    return testPartial(res, match);
}

export function internalEc(src: {
    from: Address | string,
    to: Address | string,
    value: {coins: bigint, ec: Array<[number, bigint]>} ,
    bounce?: boolean,
    init?: StateInit,
    body?: Cell
}): Message {

    // Resolve bounce
    let bounce = true;
    if (src.bounce !== null && src.bounce !== undefined) {
        bounce = src.bounce;
    }

    // Resolve address
    let to: Address;
    let from: Address;
    if (typeof src.to === 'string') {
        to = Address.parse(src.to);
    } else if (Address.isAddress(src.to)) {
        to = src.to;
    } else {
        throw new Error(`Invalid address ${src.to}`);
    }

    if (typeof src.from === 'string') {
        from = Address.parse(src.from);
    } else if (Address.isAddress(src.from)) {
        from = src.from;
    } else {
        throw new Error(`Invalid address ${src.from}`);
    }



    // Resolve value
    let other = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5));
    for(let tuple of src.value.ec) {
        other.set(tuple[0], tuple[1]);
    }
    let value: CurrencyCollection = {
        coins: src.value.coins,
        other
    };

    // Resolve body
    let body: Cell = Cell.EMPTY;
    if (typeof src.body === 'string') {
        body = beginCell().storeUint(0, 32).storeStringTail(src.body).endCell();
    } else if (src.body) {
        body = src.body;
    }

    // Create message
    return {
        info: {
            type: 'internal',
            src: from,
            dest: to,
            value,
            bounce,
            ihrDisabled: true,
            bounced: false,
            ihrFee: 0n,
            forwardFee: 0n,
            createdAt: 0,
            createdLt: 0n
        },
        init: src.init ?? undefined,
        body: body
    };
}

export function internalEcRelaxed(src: {
    to: Address | string,
    value: {coins: bigint, ec: Array<[number, bigint]>} ,
    bounce?: boolean,
    init?: StateInit,
    body?: Cell
}): MessageRelaxed {

    // Resolve bounce
    let bounce = true;
    if (src.bounce !== null && src.bounce !== undefined) {
        bounce = src.bounce;
    }

    // Resolve address
    let to: Address;
    if (typeof src.to === 'string') {
        to = Address.parse(src.to);
    } else if (Address.isAddress(src.to)) {
        to = src.to;
    } else {
        throw new Error(`Invalid address ${src.to}`);
    }

    // Resolve value
    let other = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5));
    for(let tuple of src.value.ec) {
        other.set(tuple[0], tuple[1]);
    }
    let value: CurrencyCollection = {
        coins: src.value.coins,
        other
    };

    // Resolve body
    let body: Cell = Cell.EMPTY;
    if (typeof src.body === 'string') {
        body = beginCell().storeUint(0, 32).storeStringTail(src.body).endCell();
    } else if (src.body) {
        body = src.body;
    }

    // Create message
    return {
        info: {
            type: 'internal',
            dest: to,
            value,
            bounce,
            ihrDisabled: true,
            bounced: false,
            ihrFee: 0n,
            forwardFee: 0n,
            createdAt: 0,
            createdLt: 0n
        },
        init: src.init ?? undefined,
        body: body
    };
}

export function computedGeneric<T extends Transaction>(transaction: T) {
    if(transaction.description.type !== "generic")
        throw("Expected generic transactionaction");
    if(transaction.description.computePhase.type !== "vm")
        throw("Compute phase expected")
    return transaction.description.computePhase;
}

export function storageGeneric<T extends Transaction>(transaction: T) {
    if(transaction.description.type !== "generic")
        throw("Expected generic transactionaction");
    const storagePhase = transaction.description.storagePhase;
    if(storagePhase  === null || storagePhase === undefined)
        throw("Storage phase expected")
    return storagePhase;
}
