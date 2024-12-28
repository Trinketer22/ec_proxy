import { toNano, Address } from '@ton/core';
import { jettonContentToCell, Minter } from '../wrappers/Minter';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const walletCode = await compile('Wallet');
    if(!process.env.ADMIN_ADDRESS) {
        throw Error("ADMIN_ADDRESS env is required");
    }
    if(!process.env.CURRENCY_ID) {
        throw Error("CURRENCY_ID env is required");
    }

    const content = jettonContentToCell({
        type: 'onchain',
        data: {
            name: "TestEC",
            symbol: 'TEC',
            decimals: '9',
            description: 'Test extra currency'
        }
    });
    const minter = provider.open(Minter.createFromConfig({
        admin: Address.parse(process.env.ADMIN_ADDRESS),
        curId: BigInt(process.env.CURRENCY_ID),
        content: content,
        walletCode
    }, await compile('Minter')));

    await minter.sendDeploy(provider.sender(), toNano('0.15'));

    await provider.waitForDeploy(minter.address);

    // run methods on `minter`
}
