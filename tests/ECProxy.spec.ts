import { Blockchain, BlockchainSnapshot, internal, SandboxContract, TreasuryContract, SmartContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, storeMessage, toNano, fromNano } from '@ton/core';
import { Minter, OnChainString, jettonContentToCell } from '../wrappers/Minter';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { ECProxyTest } from '../wrappers/ECProxyTest';
import { ECErrors, Ops } from '../wrappers/Constants';
import { computedGeneric, getRandomInt, internalEc, internalEcRelaxed, storageGeneric, testDiscovery, testJettonNotification } from './utils';
import { findTransaction, findTransactionRequired } from '@ton/test-utils';
import { getSecureRandomBytes, sha256 } from '@ton/crypto';
import { collectCellStats, computeFwdFees, computeGasFee, getGasPrices, getMsgPrices } from './gasUtils';
import { WithdrawOptions } from '../wrappers/ECProxy';

describe('EC Proxy', () => {
    let minterCode: Cell;
    let walletCode: Cell;

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let receiver: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<Minter>;
    let deployerProxy: SandboxContract<ECProxyTest>;

    let gasPrices: ReturnType<typeof getGasPrices>;
    let msgPrices: ReturnType<typeof getMsgPrices>;

    let simpleTransferGas: bigint;
    let fullTransferGas: bigint;
    let sendTransferGas: bigint;

    let userWallet: (user: Address) => Promise<SandboxContract<ECProxyTest>>;
    let getContractEc: (contract: Address) => Promise<SmartContract['ec']>
    let getContractEcBalance: (contract: Address, id: number) => Promise<bigint>;

    let withExcessCurrency: BlockchainSnapshot;

    beforeAll(async () => {
        minterCode = await compile('Minter');
        walletCode = await compile('Wallet');
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        receiver = await blockchain.treasury('receiver');

        gasPrices = getGasPrices(blockchain.config, 0);
        msgPrices = getMsgPrices(blockchain.config, 0);

        minter = blockchain.openContract(Minter.createFromConfig({
            curId: 123n,
            admin: deployer.address,
            walletCode,
            content: jettonContentToCell({
                type: 'offchain',
                uri: 'https://test_uri.com/meta.json'
            })
        }, minterCode));


        userWallet = async (user) => {
            return blockchain.openContract(
                ECProxyTest.createFromAddress(
                    await minter.getWalletAddress(user)
                )
            );
        }

        getContractEc =  async (contract) => {
            const smc = await blockchain.getContract(contract);
            if(smc.accountState?.type !== 'active') {
                throw Error("Contract is not active!");
            }
            return smc.ec;
        };
        getContractEcBalance = async (address, id) => {
            const smc = await blockchain.getContract(address);
            return smc.ec[id] ?? 0n;
        }

        const deployResult = await minter.sendDeployWallet(deployer.getSender(), 
                                                           deployer.address,
                                                           deployer.address)

        deployerProxy = await userWallet(deployer.address);

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: minter.address,
            deploy: true,
            success: true,
            outMessagesCount: 1
        });
        expect(deployResult.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: minter.address,
            op: Ops.wallet.internal_deploy,
            aborted: false
        });
        let topUpAmount = BigInt(10 ** 8);
        let ecSetup: [number, bigint][] = [
            [ 123, topUpAmount ],
            [ 456, topUpAmount ],
            [ 789, topUpAmount ],
        ];
        await blockchain.sendMessage(internal({
            from: deployer.address,
            to: deployer.address,
            value: toNano('1'),
            ec: ecSetup
        }));

        let ecAfter = await getContractEc(deployer.address);
        for(let id of [123, 456, 789]) {
            expect(ecAfter[id]).toEqual(topUpAmount);
        }

        // For contract setter testing sake

        const smc = await blockchain.getContract(deployer.address);

        smc.ec = {
            123: topUpAmount * 2n,
            456: topUpAmount * 3n,
            789: topUpAmount * 4n,
        }

        ecAfter = await getContractEc(deployer.address);

        let i = 1;
        for(let id of [123, 456, 789]) {
            expect(ecAfter[id]).toEqual(topUpAmount * BigInt(1 + i++));
        }
    });

    it('should deploy proxy', async () => {
    });

    describe('Minter', () => {
        it('should mint proxy to closest to owner shard', async () => {
            let successCount = 0;
            let totalGas     = 0n;
            let totalSpent   = 0n;
            for(let i = 0; i < 100; i++) {
                try {
                    const testAddress = new Address(0, await getSecureRandomBytes(32));
                    const testProxy   = await userWallet(testAddress);
                    const deployResult = await minter.sendDeployWallet(deployer.getSender(),
                                                                       testAddress,
                                                                       deployer.address);
                    const deployTx = findTransactionRequired(deployResult.transactions, {
                        from: deployer.address,
                        on: minter.address,
                        op: Ops.minter.deploy_wallet,
                        aborted: false,
                    })!;
                    const deployIntTx = findTransactionRequired(deployResult.transactions, {
                        on: testProxy.address,
                        from: minter.address,
                        op: Ops.wallet.internal_deploy,
                        deploy: true,
                        aborted: false
                    });
                    // console.log("DeployIntTx gas:", computedGeneric(deployIntTx).gasUsed);
                    const fees = computedGeneric(deployTx);
                    totalGas   += fees.gasUsed;
                    totalSpent += fees.gasFees;

                    expect(testProxy.address.hash[0] >> 4).toEqual(testAddress.hash[0] >> 4);
                    successCount++;
                } catch {
                }
            }

            console.log(`Same shard mint ${successCount}/100`);
            console.log('Total gas spent during same shard testing:', totalGas);
            console.log('Average gas:', totalGas / 100n);
            console.log('Average cost:', fromNano(totalSpent / 100n));

            expect(successCount).toBeGreaterThanOrEqual(80);
        });
        it('wallet discovery result should match get_wallet_address call', async () => {
            // await blockchain.loadFrom(initialState);
            let totalFees = 0n;
            for(let i = 0; i < 1; i++) {
                const testAddress = new Address(0, await getSecureRandomBytes(32));
                const testProxy   = await userWallet(testAddress);

                for(let includeAddr of [false, true]) {
                    let res = await minter.sendDiscovery(deployer.getSender(), testAddress, includeAddr);
                    const discoveryTx = findTransactionRequired(res.transactions, {
                        on: minter.address,
                        from: deployer.address,
                        op: Ops.minter.provide_wallet_address
                    });
                    console.log("Discovery", computedGeneric(discoveryTx).gasUsed);
                    const lookupTx = findTransactionRequired(res.transactions, {
                        on: deployer.address,
                        from: minter.address,
                        op: Ops.minter.take_wallet_address,
                        body: b => testDiscovery(b!, {
                            proxy: testProxy.address,
                            owner: includeAddr ? testAddress : null
                        })
                    });
                    const inMsg = lookupTx.inMessage!;
                    if(inMsg.info.type !== 'internal') {
                        throw Error("No way");
                    }
                    totalFees += toNano('0.05') - inMsg.info.value.coins;
                }
            }
            console.log("Discovery average cost:", fromNano(totalFees / 200n));
            // console.log("100K gas costs:", fromNano(computeGasFee(gasPrices, 100000n)));
        });
        it('admin should be able to update content', async () => {
            const getBefore = await minter.getJettonData();
            expect(getBefore.owner).toEqualAddress(deployer.address);

            const newUrl     = 'https://new_jetton/meta.json';
            const newContent = jettonContentToCell({
                type: 'onchain',
                data: {
                    uri: newUrl,
                    decimals: '9'
                }
            });

            let contentDict = Dictionary.loadDirect(Dictionary.Keys.Buffer(32), OnChainString(), newContent.refs[0]);

            let res = await minter.sendChangeContent(deployer.getSender(), newContent);
            expect(res.transactions).toHaveTransaction({
                on: minter.address,
                from: deployer.address,
                op: Ops.minter.change_content,
                aborted: false
            });
            expect(res.transactions).toHaveTransaction({
                from: minter.address,
                to: deployer.address,
                op: Ops.wallet.excesses,
                value: (v) => v! > 0n
            });
            
            const getAfter = await minter.getJettonData();
            // Content should change
            expect(getAfter.content).toEqualCell(newContent);
            expect(contentDict.get(await sha256("uri"))).toEqual(newUrl)
            expect(contentDict.get(await sha256("decimals"))).toEqual('9')
            // Make sure nothing is broken
            expect(getAfter.owner).toEqualAddress(getBefore.owner!);
            expect(getAfter.supply).toEqual(getBefore.supply);
            expect(getAfter.mintable).toEqual(getBefore.mintable);
            expect(getAfter.wallet_code).toEqualCell(getBefore.wallet_code);
        });
        it('not admin should not be able to update content', async () => {
            const newContent = jettonContentToCell({
                type: 'onchain',
                data: {
                    uri: 'https://new_jetton/meta.json',
                    decimals: '9'
                }
            });
            const stateBefore = await minter.getState();
            if(stateBefore.state.type !== 'active') {
                throw Error("Contract not active");
            }
            let res = await minter.sendChangeContent(receiver.getSender(), newContent);
            expect(res.transactions).toHaveTransaction({
                on: minter.address,
                from: receiver.address,
                op: Ops.minter.change_content,
                aborted: true,
                exitCode: ECErrors.invalid_sender
            });

            const stateAfter = await minter.getState();
            if(stateAfter.state.type !== 'active') {
                throw Error("Contract not active");
            }
            expect(stateAfter.state.data).toEqual(stateBefore.state.data);
        });
        it('not admin should not be able to drop admin', async () => {
            const getBefore = await minter.getJettonData();
            let res = await minter.sendDropAdmin(receiver.getSender());
            expect(res.transactions).toHaveTransaction({
                on: minter.address,
                from: receiver.address,
                op: Ops.minter.drop_admin,
                aborted: true,
                exitCode: ECErrors.invalid_sender
            });

            const getAfter = await minter.getJettonData();
            expect(getBefore.owner).toEqualAddress(getAfter.owner!);
        });
        it('admin should be able to drop admin', async () => {
            const getBefore = await minter.getJettonData();
            expect(getBefore.owner).toEqualAddress(deployer.address);

            let res = await minter.sendDropAdmin(deployer.getSender());

            expect(res.transactions).toHaveTransaction({
                on: minter.address,
                from: deployer.address,
                op: Ops.minter.drop_admin,
                aborted: false
            });
            expect(res.transactions).toHaveTransaction({
                from: minter.address,
                to: deployer.address,
                op: Ops.wallet.excesses,
                value: (v) => v! > 0n
            });

            const getAfter = await minter.getJettonData();
            expect(getAfter.owner).toBeNull();

            expect(getAfter.supply).toEqual(getBefore.supply);
            expect(getAfter.mintable).toEqual(getBefore.mintable);
            expect(getAfter.wallet_code).toEqualCell(getBefore.wallet_code);
        });
    });

    it('should accept EC from message with comment and notify owner', async() => {
        // For whatever reason ton/core takes header bits instead of value bits
        const testBody = beginCell().storeUint(0, 32).storeStringTail("Hello").endCell();
        const testAmount = BigInt(getRandomInt(1, 10 ** 6));


        const smc = await blockchain.getContract(deployerProxy.address);
        const balanceBefore = smc.balance;

        let res = await deployer.sendMessages([internalEcRelaxed({
            to: deployerProxy.address,
            value: {coins: toNano('1'), ec: [[123, testAmount]]},
            body: testBody
        })]);

        expect(await getContractEcBalance(deployerProxy.address, 123)).toEqual(testAmount);
        const simpleTransfer = findTransactionRequired(res.transactions, {
            on: deployerProxy.address,
            from: deployer.address,
            op: 0,
            aborted: false,
            outMessagesCount: 2
        });

        simpleTransferGas = computedGeneric(simpleTransfer).gasUsed;
        console.log("Simple transfer gas:", simpleTransferGas);

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.transfer_notification,
            body: (x) => testJettonNotification(x!, {
                from: deployer.address,
                amount: testAmount,
                payload: testBody
            }),
            value: 0n,
        });
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.excesses,
            value: (v) => v! > 0n
        });

        expect(balanceBefore).toEqual(smc.balance);
    });
    it('should accept EC from fully formated message and notify owner', async () => {
        const testBody = beginCell().storeStringTail("Official greetings!").endCell();
        const testAmount = BigInt(getRandomInt(1, 10 ** 6));
        const forwardAmount  = BigInt(getRandomInt(1, 10)) * toNano('0.1');
        const ecTransferBody = ECProxyTest.ecTransferMessage(forwardAmount,
                                                             receiver.address,
                                                             testBody);
        let res = await deployer.sendMessages([internalEcRelaxed({
            to: deployerProxy.address,
            value: {coins: toNano('10'), ec: [[123, testAmount]]},
            body: ecTransferBody
        })]);

        // Difference between this more is
        // 1) Specific refund address
        // 2) Specific forward amount

        const fullTransferTx = findTransactionRequired(res.transactions, {
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.ec_transfer,
            aborted: false,
            outMessagesCount: 2
        });
        fullTransferGas = computedGeneric(fullTransferTx).gasUsed;
        console.log("Full transfer gas:", fullTransferGas);
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.transfer_notification,
            body: (b) => testJettonNotification(b!, {
                from: deployer.address,
                amount: testAmount,
                payload: testBody
            }),
            aborted: false,
            value: forwardAmount
        });
        expect(res.transactions).toHaveTransaction({
            on: receiver.address,
            from: deployerProxy.address,
            op: Ops.wallet.excesses,
            value: (v) => v! > 0n
        });
    });
    it('on sucess should return all incoming EC, except specified in state to refund address', async () => {
        const testBody = beginCell().storeUint(0, 32).storeStringTail("Official greetings!").endCell();
        const testAmount = BigInt(getRandomInt(1, 10));
        const amount456  = BigInt(getRandomInt(11, 20));
        const amount789  = BigInt(getRandomInt(21, 30));
        const forwardAmount  = BigInt(getRandomInt(1, 10)) * toNano('0.1');
        const ecTransferBody = ECProxyTest.ecTransferMessage(forwardAmount,
                                                             receiver.address,
                                                             testBody);
        let i = 0;
        // Make sure it refunds EC in both transfer modes
        for(let testPayload of [ecTransferBody, testBody]) {
            const ecBefore  = await getContractEc(deployerProxy.address);
            const before123 = ecBefore[123]; // await getContractEcBalance(deployerProxy.address, 123);
            const before456 = ecBefore[456]; // await getContractEcBalance(deployerProxy.address, 456);
            const before789 = ecBefore[789]; // await getContractEcBalance(deployerProxy.address, 789);

            let res = await deployer.sendMessages([internalEcRelaxed({
                to: deployerProxy.address,
                value: {coins: toNano('10'), ec: [
                    [123, testAmount], // legit
                    // Non-legitimate
                    [456, amount456],
                    [789, amount789],
                ]},
                body: testPayload
            })]);

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: deployerProxy.address,
                op: Ops.wallet.transfer_notification,
                // value: forwardAmount,
                body: (b) => testJettonNotification(b!, {
                    from: deployer.address,
                    amount: testAmount,
                    payload: testBody
                })
            });
            // Make sure owner doesn't get notified about other amounts
            for(let amount of [amount456, amount789]) {
                expect(res.transactions).not.toHaveTransaction({
                    on: deployer.address,
                    from: deployerProxy.address,
                    op: Ops.wallet.transfer_notification,
                    body: (b) => testJettonNotification(b!, {
                        amount
                    })
                });
            }
            expect(res.transactions).toHaveTransaction({
                on: i == 0 ? receiver.address : deployer.address, // in case of full transfer funds are returned to receiver, sender otherwise.
                from: deployerProxy.address,
                op: Ops.wallet.excesses,
                ec: [
                      [ 456, amount456],
                      [ 789, amount789]
                ],
                aborted: false
            })

            const ecAfter = await getContractEc(deployerProxy.address);
            expect(ecAfter[123]).toEqual(before123 + testAmount);
            expect(ecAfter[456]).toEqual(before456);
            expect(ecAfter[789]).toEqual(before789);

            i++;
        }
    });

    it('owner should be able to transfer ec from proxy', async () => {
        const smc = await blockchain.getContract(deployerProxy.address);
        const tonBalanceBefore = smc.balance;
        const balanceBefore  = await getContractEcBalance(deployerProxy.address, 123);
        const receiverBefore = await getContractEcBalance(receiver.address, 123);

        let txAmount = BigInt(getRandomInt(1, 1000));
        let testPayload = beginCell().storeUint(getRandomInt(1000, 10000), 32).endCell();
        const res =  await deployerProxy.sendTransfer(deployer.getSender(),
                                                     toNano('1'),
                                                     txAmount,
                                                     receiver.address,
                                                     deployer.address,
                                                     null,
                                                     toNano('0.1'),
                                                     testPayload);

        const transferTx = findTransactionRequired(res.transactions, {
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.transfer,
            outMessagesCount: 2,
            aborted: false,
        });
        const transferGas = computedGeneric(transferTx);
        const transferStorage = storageGeneric(transferTx);

        sendTransferGas = transferGas.gasUsed;
        console.log("Send transfer gas:", sendTransferGas);

        expect(res.transactions).toHaveTransaction({
            from: deployerProxy.address,
            to: receiver.address,
            op: Ops.wallet.ec_transfer,
            value: (v) => v! > toNano('0.1')
        });


        expect(await getContractEcBalance(deployerProxy.address, 123)).toEqual(balanceBefore - txAmount);
        expect(await getContractEcBalance(receiver.address, 123)).toEqual(receiverBefore + txAmount);
        // Transfer transaction doesn't have storage reserve
        expect(smc.balance).toEqual(tonBalanceBefore - transferStorage.storageFeesCollected);
    });
    it('non-owner should not be able to transfer from ec proxy', async () => {
        let txAmount = BigInt(getRandomInt(1, 1000));
        let testPayload = beginCell().storeUint(getRandomInt(1000, 10000), 32).endCell();
        const res =  await deployerProxy.sendTransfer(receiver.getSender(),
                                                       toNano('1'),
                                                       txAmount,
                                                       receiver.address,
                                                       receiver.address,
                                                       null,
                                                       toNano('0.1'),
                                                       testPayload);
        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: receiver.address,
            op: Ops.wallet.transfer,
            aborted: true,
            exitCode: ECErrors.invalid_sender
        });
        expect(res.transactions).not.toHaveTransaction({
            on: receiver.address,
            from: deployerProxy.address,
            op: Ops.wallet.ec_transfer
        });
    });
    it('ecProxyA->ecProxyB transfer should result in B owner getting notification', async () => {
        const deployResult = await minter.sendDeployWallet(receiver.getSender(), 
                                                           receiver.address,
                                                           receiver.address)

        const receiverProxy = await userWallet(receiver.address);
        
        expect(deployResult.transactions).toHaveTransaction({
            from: receiver.address,
            to: minter.address,
            op: Ops.minter.deploy_wallet,
            success: true,
            outMessagesCount: 1
        });
        expect(deployResult.transactions).toHaveTransaction({
            on: receiverProxy.address,
            from: minter.address,
            op: Ops.wallet.internal_deploy,
            aborted: false
        });
        expect(deployResult.transactions).toHaveTransaction({
            on: receiver.address,
            from: receiverProxy.address,
            op: Ops.wallet.excesses
        });

        const receiverBalanceBefore = await getContractEcBalance(receiverProxy.address, 123);
        const proxyFirst   = await blockchain.getContract(deployerProxy.address);
        const proxySecond  = await blockchain.getContract(receiverProxy.address);
        const secondBefore = proxySecond.balance;
        const firstBefore  = proxyFirst.balance;
        let txAmount    = BigInt(getRandomInt(1, 1000));
        let fwdAmount   = BigInt(getRandomInt(1, 5)) * toNano('0.1');
        let testPayload = beginCell().storeUint(getRandomInt(1000, 10000), 32).endCell();

        const res = await deployerProxy.sendTransfer(deployer.getSender(),
                                                      toNano('1'),
                                                      txAmount,
                                                      receiverProxy.address,
                                                      deployer.address,
                                                      null,
                                                      fwdAmount,
                                                      testPayload);
        const transferTx = findTransactionRequired(res.transactions, {
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.transfer,
            aborted: false
        });
        const transferStorage = storageGeneric(transferTx);
        const proxyTx = findTransactionRequired(res.transactions, {
            on: receiverProxy.address,
            from: deployerProxy.address,
            op: Ops.wallet.ec_transfer,
            aborted: false
        });

        expect(res.transactions).toHaveTransaction({
            from: receiverProxy.address,
            to: receiver.address,
            op: Ops.wallet.transfer_notification,
            value: fwdAmount,
            body: (b) => testJettonNotification(b!, {
                from: deployerProxy.address,
                amount: txAmount,
                payload: testPayload
            }),
            aborted: false
        });
        // Ton balance should not bleed
        expect(proxyFirst.balance).toEqual(firstBefore - transferStorage.storageFeesCollected);
        // Second one could grow a bit if ton excess is < excess message sending  fee
        expect(proxySecond.balance).toBeGreaterThanOrEqual(secondBefore);
        const excessTx = findTransaction(res.transactions, {
            on: deployer.address,
            from: receiverProxy.address,
            op: Ops.wallet.excesses
        });
        if(excessTx) {
            console.log("Excess tx:", excessTx.inMessage);
        } else {
            console.log("No excess!");
        }
    });
    it('proxy->proxy transfer should work with minimal value', async () => {
        const receiverProxy = await userWallet(receiver.address);
        const receiverBalanceBefore = await getContractEcBalance(receiverProxy.address, 123);

        const proxyFirst   = await blockchain.getContract(deployerProxy.address);
        const proxySecond  = await blockchain.getContract(receiverProxy.address);
        const secondBefore = proxySecond.balance;
        const firstBefore  = proxyFirst.balance;

        // Picked in such a way grams storage bits are static and fwd fee doesn't change
        let txAmount    = BigInt(getRandomInt(512, 1023));
        let fwdAmount   = BigInt(getRandomInt(1, 5)) * toNano('0.1');
        let minAmount   = toNano('0.0109316');
        let testPayload = beginCell().storeUint(getRandomInt(1000, 10000), 32).endCell();

        let res = await deployerProxy.sendTransfer(deployer.getSender(),
                                                    minAmount + fwdAmount,
                                                    txAmount,
                                                    receiverProxy.address,
                                                    deployer.address,
                                                    null,
                                                    fwdAmount,
                                                    testPayload);
        const transferTx = findTransactionRequired(res.transactions, {
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.transfer,
            aborted: false
        });
        const transferStorage = storageGeneric(transferTx);

        const proxyTx = findTransactionRequired(res.transactions, {
            on: receiverProxy.address,
            from: deployerProxy.address,
            op: Ops.wallet.ec_transfer,
            aborted: false
        });
        expect(res.transactions).toHaveTransaction({
            on: receiver.address,
            from: receiverProxy.address,
            op: Ops.wallet.transfer_notification,
            body: (b) => testJettonNotification(b!, {
                from: deployerProxy.address,
                amount: txAmount,
                payload: testPayload
            }),
            aborted: false
        })
        expect(await getContractEcBalance(receiverProxy.address, 123)).toEqual(receiverBalanceBefore + txAmount);;
        // Ton balance should not bleed
        expect(proxyFirst.balance).toBeGreaterThanOrEqual(firstBefore - transferStorage.storageFeesCollected);
        // Second one could grow a bit if ton excess is < excess message sending  fee
        expect(proxySecond.balance).toBeGreaterThanOrEqual(secondBefore);

        res = await deployerProxy.sendTransfer(deployer.getSender(),
                                                minAmount + fwdAmount - 1n,
                                                txAmount,
                                                receiverProxy.address,
                                                deployer.address,
                                                null,
                                                fwdAmount,
                                                testPayload);
        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.transfer,
            aborted: true,
            exitCode: ECErrors.not_enough_gas
        });
        expect(res.transactions).not.toHaveTransaction({
            on: receiverProxy.address,
            from: deployerProxy.address
        });
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            inMessageBounced: true
        });
    });
    it('simple ec transfer should work with minimal value', async () => {
        let txAmount = BigInt(getRandomInt(1, 1023));
        let testBody = beginCell().storeUint(0, 32).endCell(); // Smallest acceptable body - just op and empty comment

        let fullMsg  = beginCell().store(storeMessage(internal({
            to: deployerProxy.address,
            from: deployer.address,
            value: 0n,
            ec: [[123, txAmount]],
            body: testBody
        }))).endCell();

        const stats = collectCellStats(fullMsg, [], true);
        const expFwdFee = computeFwdFees(msgPrices, stats.cells, stats.bits) * 3n / 2n;
        const gasFee    = computeGasFee(gasPrices, simpleTransferGas);

        let res = await deployer.sendMessages([internalEcRelaxed({
            value: {coins: gasFee + expFwdFee, ec: [[123, txAmount]]},
            to: deployerProxy.address,
            body: testBody
        })]);
        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: deployer.address,
            op: 0,
            aborted: false
        });
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.transfer_notification,
            body: b => testJettonNotification(b!, {
                from: deployer.address,
                amount: txAmount,
                payload: testBody
            })
        });
        // console.log(gasFee + expFwdFee);
        // console.log("Expect to fail");
        res = await deployer.sendMessages([internalEcRelaxed({
            value: {coins: gasFee + msgPrices.lumpPrice - 1n, ec: [[123, txAmount]]},
            to: deployerProxy.address,
            body: testBody
        })]);

        expect(res.transactions).not.toHaveTransaction({
            from: deployerProxy.address,
            to: deployer.address,
            op: Ops.wallet.transfer_notification,
        });
        // Expect refund
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.ton_refund,
            body: (b) => {
                const ds = b!.beginParse().skip(32 + 64);
                return ds.loadUint(10) == ECErrors.not_enough_gas;
            }
        });
    });
    it('not owner should not be able to update forward gas amount', async () => {
        const newForwardGas = BigInt(getRandomInt(1000, 10000));
        let res = await deployerProxy.sendUpdateForwardGas(receiver.getSender(), newForwardGas);

        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: receiver.address,
            op: Ops.wallet.update_forward_gas,
            aborted: true,
            success: false
        });
    });
    it('owner should be able to update forward gas amount', async () => {
        let dataBefore = await deployerProxy.getWalletDataExtended();
        const newForwardGas = BigInt(getRandomInt(1000, 10000));
        let res = await deployerProxy.sendUpdateForwardGas(deployer.getSender(), newForwardGas);

        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.update_forward_gas,
            aborted: false
        });

        const gasAfter = await deployerProxy.getForwardGas();
        expect(gasAfter.forwardGas).toEqual(newForwardGas);
        expect(gasAfter.forwardGasFee).toEqual(computeGasFee(gasPrices, newForwardGas));

        const dataAfter = await deployerProxy.getWalletDataExtended();

        expect(dataAfter.balance).toEqual(dataBefore.balance);
        expect(dataAfter.inited).toEqual(dataBefore.inited);
        expect(dataAfter.currencyId).toEqual(dataBefore.currencyId);
        expect(dataAfter.minter).toEqualAddress(dataBefore.minter);
        expect(dataAfter.owner).toEqualAddress(dataBefore.owner);
        expect(dataAfter.salt).toEqual(dataBefore.salt);
        expect(dataAfter.wallet_code).toEqualCell(dataBefore.wallet_code);
    });
    it('simple transfer now should require additional gas', async () => {
        const gasReq = await deployerProxy.getForwardGas();

        expect(gasReq.forwardGas).toBeGreaterThan(0n);

        let txAmount = BigInt(getRandomInt(1, 1023));
        let testBody = beginCell().storeUint(0, 32).endCell(); // Smallest acceptable body - just op and empty comment -> fwdFee * 3 / 2 produces minimal overhead 

        let fullMsg  = beginCell().store(storeMessage(internalEc({
            to: deployerProxy.address,
            from: deployer.address,
            value: {coins: 0n, ec: [[123, txAmount]]}, // nanoton value doesn't impact forward fee
            body: testBody
        }))).endCell();

        const stats = collectCellStats(fullMsg, [], true);
        const expFwdFee = computeFwdFees(msgPrices, stats.cells, stats.bits) * 3n / 2n;
        const gasFee    = computeGasFee(gasPrices, simpleTransferGas);

        let res = await deployer.sendMessages([internalEcRelaxed({
            value: {coins: gasFee + expFwdFee, ec: [[123, txAmount]]},
            to: deployerProxy.address,
            body: testBody
        })]);
        
        expect(res.transactions).not.toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.transfer_notification
        });

        // Expect refund
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.ton_refund,
            body: (b) => {
                const ds = b!.beginParse().skip(32 + 64);
                return ds.loadUint(10) == ECErrors.not_enough_gas;
            }
        });

        res = await deployer.sendMessages([internalEcRelaxed({
            value: {coins: gasFee + expFwdFee + gasReq.forwardGasFee, ec: [[123, txAmount]]},
            to: deployerProxy.address,
            body: testBody
        })]);

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.transfer_notification,
            body: b => testJettonNotification(b!, {
                from: deployer.address,
                amount: txAmount,
                payload: testBody
            })
        });
    });
    it('wallet owner should be able to withdraw excess tons and EC', async () => {
        const beforeTest = blockchain.snapshot();
        const amount456  = BigInt(getRandomInt(11, 20));
        const amount789  = BigInt(getRandomInt(21, 30));
        // Will accept empty body message
        await deployer.sendMessages([internalEcRelaxed({
            to: deployerProxy.address,
            value: {coins: toNano('10'), ec: [
                // Non-legitimate
                [456, amount456],
                [789, amount789],
            ]},
        })]);
        const proxyEc = (await getContractEc(deployerProxy.address))!;
        expect(proxyEc[456]).toEqual(amount456);
        expect(proxyEc[789]).toEqual(amount789);

        withExcessCurrency = blockchain.snapshot();

        const res = await deployerProxy.sendWithdrawExtraEC(deployer.getSender(), deployer.address, {withdrawSpecific: false, fromBalance: toNano('10')});

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.excesses,
            value: (v) => v! >= toNano('10'),
            ec: [
                    [456, amount456],
                    [789, amount789],
            ]
        });

        const smc = await blockchain.getContract(deployerProxy.address);
        // Should leave min storage
        expect(smc.balance).toEqual(toNano('0.01'));

        await blockchain.loadFrom(beforeTest);
    });
    it('owner should be able to withdraw specific EC', async () => {
        const beforeTest = blockchain.snapshot();

        await blockchain.loadFrom(withExcessCurrency);

        const ecBefore  = await getContractEc(deployerProxy.address);
        const amount456 = ecBefore[456];
        const amount789 = ecBefore[789];

        expect(amount456).toBeGreaterThan(0n);
        expect(amount789).toBeGreaterThan(0n);

        let amountMap: { [k: number] : bigint } = {
            456: amount456,
            789: amount789
        };
        for(let wId of [456, 789]) {
            const res = await deployerProxy.sendWithdrawExtraEC(deployer.getSender(), deployer.address, {withdrawSpecific: true, curId: wId, fromBalance: toNano('1')});

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: deployerProxy.address,
                op: Ops.wallet.excesses,
                value: (v) =>  v! >= toNano('1'),
                ec: [[wId, amountMap[wId]]]
            });
        }

        await blockchain.loadFrom(beforeTest);
    });
    it('owner should be able to withdraw from balance separately from EC', async () => {
        const beforeTest = blockchain.snapshot();

        await blockchain.loadFrom(withExcessCurrency);

        const amount456 = await getContractEcBalance(deployerProxy.address, 456);
        const amount789 = await getContractEcBalance(deployerProxy.address, 789);

        expect(amount456).toBeGreaterThan(0n);
        expect(amount789).toBeGreaterThan(0n);

        // Withdraw all excess EC but leave the balance
        let res = await deployerProxy.sendWithdrawExtraEC(deployer.getSender(), deployer.address, {withdrawSpecific: false, fromBalance: 0n});

        // All excess EC should be withdrawn
        let proxyEc = await getContractEc(deployerProxy.address);
        expect(proxyEc).not.toBeUndefined();
        expect(proxyEc[456]).toBeUndefined();
        expect(proxyEc[789]).toBeUndefined();

        // But main one should stay
        const balanceBefore = proxyEc[123];
        expect(balanceBefore).toBeGreaterThan(0n);

        const toWithdraw = toNano('10');
        const smc = await blockchain.getContract(deployerProxy.address);
        expect(smc.balance).toBeGreaterThan(toWithdraw);

        // Now we want to withdraw some ton
        res = await deployerProxy.sendWithdrawExtraEC(deployer.getSender(), deployer.address, {withdrawSpecific: false, fromBalance: toWithdraw});

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            value: (v) => v! >= toWithdraw
        });

        // Original EC balance should not change
        expect(await getContractEcBalance(deployerProxy.address, 123)).toEqual(balanceBefore);
        expect(smc.balance).toBeGreaterThanOrEqual(toNano('0.01'));

        // Should not allow to withdraw below the min storage
        res = await deployerProxy.sendWithdrawExtraEC(deployer.getSender(), deployer.address, {withdrawSpecific: false, fromBalance: toWithdraw});

        expect(res.transactions).toHaveTransaction({
            on: deployerProxy.address,
            from: deployer.address,
            op: Ops.wallet.withdraw_extra,
            aborted: true,
            exitCode: ECErrors.not_enough_balance
        });
        expect(res.transactions).not.toHaveTransaction({
            on: deployer.address,
            from: deployerProxy.address,
            op: Ops.wallet.excesses
        });

        await blockchain.loadFrom(beforeTest);
    });
    it('not owner should not be able to withdraw excess', async () => {
        const beforeTest = blockchain.snapshot();

        await blockchain.loadFrom(withExcessCurrency);

        const ecBalance = await getContractEc(deployerProxy.address);
        const amount456 = ecBalance[456];
        const amount789 = ecBalance[789];

        expect(amount456).toBeGreaterThan(0n);
        expect(amount789).toBeGreaterThan(0n);

        const testCases: WithdrawOptions[] = [
            {withdrawSpecific: false},
            {withdrawSpecific: true, curId: 456},
            {withdrawSpecific: true, curId: 789}
        ];

        for(let testOpts of testCases) {
            const res = await deployerProxy.sendWithdrawExtraEC(receiver.getSender(),
                                                                deployer.address,
                                                                testOpts);
            expect(res.transactions).toHaveTransaction({
                on: deployerProxy.address,
                from: receiver.address,
                aborted: true,
                exitCode: ECErrors.invalid_sender
            });
            expect(res.transactions).not.toHaveTransaction({
                on: deployer.address,
                from: deployerProxy.address,
                op: Ops.wallet.excesses
            });
        }

        await blockchain.loadFrom(beforeTest);
    });
})
