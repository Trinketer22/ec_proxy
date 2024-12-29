import { Address, beginCell, Cell, fromNano, OpenedContract, toNano } from '@ton/core';
import { compile, NetworkProvider, UIProvider} from '@ton/blueprint';
import { jettonContentToCell, Minter } from '../wrappers/Minter';
import { promptBool, promptAmount, promptAddress, displayContentCell, getLastBlock, waitForTransaction, getAccountLastTx, promptToncoin, promptUrl, jettonWalletCodeFromLibrary, promptBigInt } from '../wrappers/ui-utils';
import {TonClient4} from "@ton/ton";
import { fromUnits, toUnits } from '../wrappers/units';
import { ECProxy, WithdrawOptions } from '../wrappers/ECProxy';
let minterContract:OpenedContract<Minter>;

const adminActions  = ['Drop admin',  'Change metadata' ];
const userActions   = ['Info', 'Deploy wallet', 'Send EC', 'Withdraw excess', 'Top up', 'Quit'];
let minterCode: Cell;
let walletCode: Cell;
let adminAddress: Address | null;
let senderAddr: Address | undefined;
let currencyId: number;
let decimals: number;


const failedTransMessage = (ui:UIProvider) => {
    ui.write("Failed to get indication of transaction completion from API!\nCheck result manually, or try again\n");

};

const infoAction = async (provider:NetworkProvider, ui:UIProvider) => {
    const jettonFull = await minterContract.getJettonDataExtended();
    ui.write("Jetton info:\n\n");
    ui.write(`Admin: ${jettonFull.owner}\n`);
    ui.write(`EC ID: ${jettonFull.currencyId}\n`);
    const displayContent = await ui.choose('Display content?', ['Yes', 'No'], (c: string) => c);
    if(displayContent == 'Yes') {
        const content = jettonFull.content;
        await displayContentCell(content, ui);
    }
};
const topUpAction = async (provider: NetworkProvider, ui: UIProvider) => {
    const topUpAmount = await promptToncoin("How much would you like to top up:", ui);
    if(!await promptBool(`Send ${fromNano(topUpAmount)} ton to minter?`, ['yes', 'no'], ui)){
        ui.write('Top up aborted!');
        return;
    }
    ui.write(`Sending ${fromNano(topUpAmount)} to minter`);

    await provider.sender().send({
        to: minterContract.address,
        value: topUpAmount
    });
}

const deployWalletAction   = async (provider: NetworkProvider, ui: UIProvider) => {
    const sender    = provider.sender();
    const deployFor = await promptAddress("Please specify addres to deploy EC proxy for:", ui);
    const refund    = await promptAddress("Please specify address for refund:", ui, sender.address);

    await minterContract.sendDeployWallet(sender, deployFor, refund);
}
const sendAction    = async (provider: NetworkProvider, ui: UIProvider) => {

    let to = await promptAddress("Please specify destination address:", ui);
    let tonAmount = toNano('0.05');
    const sender  = provider.sender();
    const toProxy = await promptBool("Resolve destination ec proxy address?", ['yes', 'no'], ui, true);
    if(toProxy) {
        to = await minterContract.getWalletAddress(to);
    }

    const sendAmount = await promptAmount("Please specify EC amount to send:", decimals, ui);

    const forwardTon = await promptToncoin("Please specify attached ton value(could be 0):", ui);
    tonAmount += forwardTon;


    if(!senderAddr) {
        senderAddr = sender.address ?? await promptAddress("Please specify sender address:", ui);
    }

    const refundAddress = await promptAddress("Please provide refund address:", ui, senderAddr);

    const senderProxy = provider.open(ECProxy.createFromAddress(
        await minterContract.getWalletAddress(senderAddr)
    ));

    ui.write(JSON.stringify({
        to: to.toString(),
        ec: fromUnits(sendAmount, decimals),
        total_ton: fromNano(tonAmount),
        forward_ton: fromNano(forwardTon),
    }, null, 2));
    const isOk = await promptBool("Is it ok?", ['yes', 'no'], ui);

    if(isOk) {
        await senderProxy.sendTransfer(sender,
                                       tonAmount,
                                       sendAmount,
                                       to,
                                       refundAddress,
                                       null, forwardTon, null);
    } else {
        ui.write("Sending aborted!");
    }
}

const updateMetadataAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let contentCell: Cell;
    if(process.env.CONTENT_BASE64) {
        contentCell = Cell.fromBase64(process.env.CONTENT_BASE64);
    } else {
        const jettonMetadataUri = await promptUrl("Enter jetton metadata uri (https://jettonowner.com/jetton.json)", ui)

        if (!(await promptBool(`Change metadata url to "${jettonMetadataUri}"?`, ['yes', 'no'], ui))) {
            ui.write('Update metadata aborted!');
            return;
        }
        contentCell = jettonContentToCell({
            type: 'offchain',
            uri: jettonMetadataUri
        });
    }

    await minterContract.sendChangeContent(provider.sender(), contentCell);
}

const withdrawExtraAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let withdrawOpts: WithdrawOptions;
    const sender = provider.sender();
    const withdrawSpecific = !(await promptBool("Withdraw all excess EC?", ['yes', 'no'], ui, true));
    if(!senderAddr) {
        senderAddr = sender.address ??  await promptAddress("Please specify proxy owner address:", ui);
    }

    const to = await promptAddress("Please specify destination address", ui, senderAddr);
    const fromBalance = await promptToncoin("Please specify amount to withdraw from balance:", ui);

    const senderProxy = provider.open(ECProxy.createFromAddress(
        await minterContract.getWalletAddress(senderAddr)
    ));

    if(withdrawSpecific) {
        const curId = Number(await promptBigInt("Provide currency id to withdraw:", ui));
        withdrawOpts = {
            withdrawSpecific,
            fromBalance,
            curId
        }
        ui.write(`Withdrawing all EC with id ${curId} and ${fromNano(fromBalance)} TON to ${to}`);
    } else {
        withdrawOpts = {
            withdrawSpecific: false,
            fromBalance
        }
        ui.write(`Withdrawing all EC and ${fromNano(fromBalance)} TON to ${to}`);
    }

    const isOk = await promptBool("Is it ok?", ['yes', 'no'], ui);
    if(isOk) {
        await senderProxy.sendWithdrawExtraEC(sender, to, withdrawOpts);
    } else {
        ui.write("Sending aborted!");
    }
}

const dropAdminAction = async (provider: NetworkProvider, ui: UIProvider) => {
    let curAdmin = adminAddress;
    let retry : boolean;

    if(curAdmin == null) {
        throw new Error("Current admin address is addr_none. No way to change it");
    }
    ui.write('This action is NOT REVERSIBLE!');

    const sure = await promptBool('Are you absolutely sure, you want to drop admin?', ['yes', 'no'], ui);

    if(sure) {
        await minterContract.sendDropAdmin(provider.sender());
    }
    else {
        ui.write('Operation abort');
    }
}


export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    const sender = provider.sender();
    const hasSender = sender.address !== undefined;
    minterCode = await compile('Minter');
    walletCode = await compile('Wallet');
    let   done   = false;
    let   retry:boolean;
    let   minterAddress:Address;

    do {
        retry = false;
        minterAddress = await promptAddress('Please enter minter address:', ui);
        minterContract = provider.open(
            Minter.createFromAddress(minterAddress)
        );

        try {
; 
            const minterState = await minterContract.getState()
            if(minterState.state.type !== 'active') {
                throw Error(`Address ${minterAddress} is not active: ${minterState.state.type}`);
            }
            if(!minterState.state.code) {
                throw Error(`Address ${minterAddress} has no code`);
            }
            if(!minterState.state.data) {
                throw Error(`Address ${minterAddress} has no data`);
            }
            const contractCode = Cell.fromBoc(minterState.state.code)[0];
            const codeHash = contractCode.hash();
            if(!minterCode.hash().equals(codeHash)) {
                throw Error(`Address ${minterAddress} contains code with different hash: ${codeHash.toString('hex')}`);
            }
        } catch(e) {
            ui.write(`Doesn't look like minter:${e}`);
            if(!(await promptBool("Are you sure it is the one", ['Yes', 'No'], ui, true))) {
                return;
            }

            ui.write("Ok, boss!");
        }

        const fullData = await minterContract.getJettonDataExtended();
        adminAddress   = fullData.owner;
        currencyId     = fullData.currencyId;

        decimals = Number(
            await promptAmount("Please specify contract decimals:", 0, ui)
        );

    } while(retry);

    const isAdmin  = hasSender ? (adminAddress == null ? false : adminAddress.equals(sender.address)) : true;
    let actionList:string[];
    if(isAdmin) {
        actionList = [...adminActions, ...userActions];
        ui.write("Current wallet is minter admin!\n");
    }
    else {
        actionList = userActions;
        ui.write("Current wallet is not admin!\nAvaliable actions restricted\n");
    }

    do {
        ui.clearActionPrompt();
        const action = await ui.choose("Pick action:", actionList, (c: string) => c);
        switch(action) {
            case 'Deploy wallet':
                await deployWalletAction(provider, ui);
                break;
            case 'Send EC':
                await sendAction(provider, ui);
                break;
            case 'Change metadata':
                await updateMetadataAction(provider, ui);
                break;
            case 'Drop admin':
                await dropAdminAction(provider, ui);
                break;
            case 'Info':
                await infoAction(provider, ui);
                break;
            case 'Withdraw excess':
                await withdrawExtraAction(provider, ui);
                break;
            case 'Top up':
                await topUpAction(provider, ui);
                break;
            case 'Quit':
                done = true;
                break;
            default:
                ui.write('Operation is not yet supported!');
        }
    } while(!done);
}
