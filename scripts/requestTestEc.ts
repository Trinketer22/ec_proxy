import { toNano, Address, fromNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { promptAmount, promptBool, promptToncoin } from '../wrappers/ui-utils';

const ECSwapAddress = Address.parse("kQC_rkxBuZDwS81yvMSLzeXBNLCGFNofm0avwlMfNXCwoOgr");


export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    if(provider.network() !== 'testnet') {
        throw Error("This script is intended for testnet only");
    }

    const decimals = Number(process.env.EC_DECIMALS ?? await promptAmount("Enter EC decimals:", 0, ui));
    const ecAmount = await promptAmount("Please specify desired amount of EC in decimal form", decimals, ui);
    const totalTon = toNano('3') + ecAmount;

    ui.write(`This would require ${fromNano(totalTon)} tons`);

    const isOk = await promptBool("Is it ok?", ["Yes", "No"], ui);

    if(isOk) {
        await provider.sender().send({
            to: ECSwapAddress,
            value: totalTon
        });
    } else {
        ui.write("Aborted!");
    }
}
