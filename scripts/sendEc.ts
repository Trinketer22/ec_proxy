import { toNano, Address, fromNano, SendMode, WalletContractV3R2, WalletContractV4, WalletContractV5R1, OpenedContract, beginCell } from '@ton/ton';
import { compile, NetworkProvider } from '@ton/blueprint';
import { promptAddress, promptAmount, promptBool, promptToncoin } from '../wrappers/ui-utils';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { internalEcRelaxed } from '../tests/utils';
import { fromUnits } from '../wrappers/units';

/* This script interacts directly with wallet
 * due to SenderArguments of @ton/core
 * does not support EC yet.
 * It is a temporary solution to test things out
 * in a real network
*/

export async function run(provider: NetworkProvider) {
    let wallet: WalletContractV3R2 | WalletContractV4 | WalletContractV5R1;

    if(!process.env.WALLET_MNEMONIC){
        throw Error("Wallet mnemonic required");
    }
    if(!process.env.WALLET_VERSION){
        throw Error("Wallet version required");
    }

    const keyPair = await mnemonicToPrivateKey(process.env.WALLET_MNEMONIC.split(' '));
    const walletVersion = process.env.WALLET_VERSION.toLowerCase();

    switch(walletVersion) {
        case 'v3r2':
            wallet = WalletContractV3R2.create({publicKey: keyPair.publicKey, workchain: 0});
            break;
        case 'v4':
            wallet = WalletContractV4.create({publicKey: keyPair.publicKey, workchain: 0});
            break;
        case 'v5':
            wallet = WalletContractV5R1.create({publicKey: keyPair.publicKey, workchain: 0});
            break;
        default: throw Error(`Wallet version ${walletVersion} is not supported`)
    }

    const walletContract = provider.open(wallet);
    const seqno = await walletContract.getSeqno();

    const ui = provider.ui();

    const decimals = Number(process.env.EC_DECIMALS ?? await promptAmount("Enter EC decimals:", 0, ui));
    const ecId     = Number(process.env.EC_ID ?? await promptAmount("Enter EC ID:", 0, ui));

    const ecAmount = await promptAmount("Please specify desired amount of EC to send in decimal form", decimals, ui);
    const dest = await promptAddress("Please specify address to send to:", ui);
    const tonAmount = await promptToncoin("Please specify amount of toncoint to attach:", ui);

    ui.write(JSON.stringify({
        to: dest.toString(),
        ecId,
        ecAmount: fromUnits(ecAmount, decimals),
        tonAmount: fromNano(tonAmount)
    }, null, 2));
    const isOk = await promptBool("Is it ok?", ["Yes", "No"], ui);

    if(isOk) {
        await walletContract.sendTransfer({
            seqno,
            secretKey: keyPair.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internalEcRelaxed({
                to: dest,
                body: beginCell().storeUint(0, 32).endCell(),
                value: {coins: tonAmount, ec: [[ecId, ecAmount]]}
            })]
        });
        ui.write("Transaction sent!");
    } else {
        ui.write("Aborted!");
    }
}
