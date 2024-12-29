import "storage.tolk"
import "op-codes.tolk"
import "gas.tolk"
import "../helpers/workchain.tolk"
import "../helpers/errors.tolk"
import "../helpers/messages.tolk"
import "../helpers/ec_helpers.tolk"
import "../helpers/jetton-utils.tolk"
import "messages.tolk"

import "@stdlib/gas-payments"
import "@stdlib/tvm-dicts"



const RESERVE_MODE = RESERVE_AT_MOST | RESERVE_IN_ADDITION;
fun onInternalMessage(myTonBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
	var cs    = msgFull.beginParse();
	var flags  = cs.loadMessageFlags();
	
	if(isMessageBounced(flags) || msgBody.isEndOfSlice()) {
		return;
	}

	var sender: slice = cs.loadAddress();
	var refund: slice = sender;
	var forwardPayload = msgBody;

	var op = msgBody.loadUint(32);
	var queryId = 0;
	var packed  = 0;
	var (inited, curId, owner, minter, forwardGas, salt) = loadData();

	var (ec: cell, fwdFee: int)  = cs.extractEcAndForwardFee();

	var tonReserve = getMyStorageDuePayment() + abs(
			min(0, myTonBalance - msgValue - getMinStorage())
		);


	if(op) {
		queryId = msgBody.loadUint(64);
	}

	var reserveEc: cell = createEmptyDict();

	// ton_refund is a result of error on ECProxy contract
	// If refund received, accept it rather that proxy
	if(op == ton_refund) {
		return;
	}
	if(op == internal_deploy) {
		assert(inited == 0, already_inited);
		var (wc, hash, isStandard) = isStandardAddress(owner);
		assert(isStandard, invalid_message); 
		var excessAddr = msgBody.loadAddress();
		(wc, hash, isStandard) = isStandardAddress(excessAddr);
		if(isStandard == 0) {
			excessAddr = owner;
		}
		forwardGas = msgBody.loadCoins();
		msgBody.assertEndOfSlice();
		sendExcess(tonReserve, RESERVE_MODE, createEmptyDict(), excesses, queryId, 0, excessAddr);
		saveData(1, curId, owner, minter, forwardGas, salt);

		return;
	}

	assert(inited, not_inited);

        var forwardGasFee = forwardGas > 0 ? calculateGasFee(MY_WORKCHAIN, forwardGas) : 0;

	if(op == transfer) {
		assert(isSliceBitsEqual(sender, owner), invalid_sender);
		var lookupCost: int  = getGasConsumedAtTheMoment();
		var (ecBalance, ecFull) = getEcBalance(getRawEc(), curId);
		/* Actual cost - cost of EC lookup of balance with single element
		* In case of 0 elements lookupCost is negative,
		* but ecBalance will be 0 and balance check will fail
		*/
		lookupCost = getGasConsumedAtTheMoment() - lookupCost - GET_BALANCE_SINGLE_EC;
		var amount = msgBody.loadCoins();
		assert(amount > 0, invalid_amount);
		assert(amount < ecBalance, not_enough_ec_balance);
		var dest   = msgBody.loadAddress();
		var (wc, hash, isStd) = isStandardAddress(dest);
		assert(isStd, invalid_address);
		assert(wc == MY_WORKCHAIN, wrong_workchain);

		var resp = msgBody.loadAddress();
		(wc, hash, isStd) = isStandardAddress(resp);
		if(isStd) {
			// In case of throw
			refund = resp;
		}

		msgBody.skipMaybeRef(); // Skip custom payload
		var tonAmount = msgBody.loadCoins();
                fwdFee       = calculateOriginalMessageFee(MY_WORKCHAIN, fwdFee);
		var extraFee = mulDivFloor(fwdFee, 3, 2);
		if(tonAmount > 0) {
			// User expects another proxy contract to execute ec_transfer
			forwardGasFee = max(forwardGasFee, calculateGasFee(MY_WORKCHAIN, RECEIVE_TRANSFER_PACKED) + fwdFee);
		}
		var gasRequired = tonAmount + calculateGasFee(MY_WORKCHAIN, SEND_TRANSFER + lookupCost) + forwardGasFee + extraFee;
                // debugPrint(gasRequired);
		assert(msgValue >= gasRequired, not_enough_gas);

		forwardPayload = msgBody.checkEitherForwardPayload();
		// Packing requested amount of EC into dictionary
		var packedEc   = packEcValue(curId, amount);
		sendEcTransfer(packedEc,
		               forwardGasFee,
		               tonAmount,
		               queryId,
		               dest,
		               refund,
		               forwardPayload);

		// RESERVE_AT_MOST doesn't yet work for EC, so we reserve pervious balance - withdrawn amount of EC
		sendExcess(0, RESERVE_MODE | RESERVE_EXCEPT, packedEc, excesses, queryId, 0, refund);
		return;
	}
	if(op == withdraw_extra) {
		assert(isSliceBitsEqual(sender, owner), invalid_sender);
		var ecBalance : int = 0;
		if(msgBody.loadUint(1)) {
			var withdrawCur = msgBody.loadUint(32);
			/*
			* Fool proof. Not alowing to ocasionally withdraw current EC.
			* Should use regular transfer instread
			*/
			assert(withdrawCur != curId, invalid_ec);
			(ecBalance, reserveEc) = getEcBalance(getRawEc(), withdrawCur);
			assert(ecBalance, not_enough_ec_balance);
		} else {
			reserveEc = getRawEc();
			// Removing current EC from reserve dictionary
			reserveEc.uDictDelete(32, curId);
		}

		var fromBalance = msgBody.loadCoins();
		var to = msgBody.loadAddress();
		msgBody.assertEndOfSlice();

		if(fromBalance > 0) {
			fromBalance = min(fromBalance, myTonBalance - msgValue - getMinStorage());
			assert(fromBalance > 0, not_enough_balance);
		}

		var (wc, hash, isStd) = isStandardAddress(to);
		assert(isStd, invalid_address);

		sendExcess(fromBalance, RESERVE_MODE | RESERVE_EXCEPT, reserveEc, excesses, queryId, 0, to);
		return;
	}
	if(op == update_forward_gas) {
		assert(isSliceBitsEqual(sender, owner), invalid_sender);
		var newForwardGas = msgBody.loadCoins();
		msgBody.assertEndOfSlice();

		updateForwardAmount(newForwardGas);
		sendExcess(0, RESERVE_MODE, createEmptyDict(), excesses, queryId, 0, sender);
		return;
	}
	// Handling incoming ec
	if(op == ec_transfer) {
		forwardGasFee = msgBody.loadCoins();
		var refundAddress = msgBody.loadAddress();
		var (wc, hash, isStandard) = isStandardAddress(refundAddress);
		if(isStandard) {
			refund = refundAddress;
		}
		packed = true;
	}

	try {
		assert(!ec.dictIsEmpty(), invalid_message);
		var amount: int = 0;
		var lookupCost: int  = getGasConsumedAtTheMoment();
		(amount, reserveEc) = getEcBalance(ec, curId);
		lookupCost = getGasConsumedAtTheMoment() - lookupCost - GET_BALANCE_SINGLE_EC;
		// Should have some incomming ec value
		assert(amount, invalid_message);
                // In case of full message format, forwarding of payload is included into the inbound fwd fee
                var extraFwdFee = calculateOriginalMessageFee(MY_WORKCHAIN, fwdFee);
                var gasFee: int = 0;
		if(packed) {
			forwardPayload = checkEitherForwardPayload(msgBody);
                        gasFee = RECEIVE_TRANSFER_PACKED;
		} else {
                        gasFee = RECEIVE_TRANSFER_RAW;
			forwardPayload = beginCell().storeEitherPayload(forwardPayload).endCell().beginParse();
                        // Otherwise, full message is wrapped into notification, so excess reserve is in order,
                        extraFwdFee = mulDivFloor(extraFwdFee, 3, 2);
		}
                var gasRequired = forwardGasFee + extraFwdFee + calculateGasFee(MY_WORKCHAIN, gasFee + lookupCost);
                // debugPrint(msgValue - gasRequired);
		assert(msgValue >= gasRequired, not_enough_gas);

		sendNotification(queryId, amount, sender, owner, forwardPayload, forwardGasFee);
		sendExcess(tonReserve, RESERVE_MODE , reserveEc, excesses, queryId, 0, refund);
	} catch (errCode) {
		sendExcess(tonReserve, RESERVE_MODE, createEmptyDict(), ton_refund, queryId, errCode, refund);
	}
	return;
}

get get_wallet_data() {
	var (inited, curId, owner, minter, forwardGas, salt) = loadData();
	var (balance: int, res) = getEcBalance(getRawEc(), curId);
	return (balance, owner, minter, getContractCode());
}

get get_wallet_data_extended() {
	var (inited, curId, owner, minter, forwardGas, salt) = loadData();
	var (balance: int, res) = getEcBalance(getRawEc(), curId);
	return (balance, inited, curId, owner, minter, forwardGas, salt, getContractCode());
}

get get_forward_gas() {
    var (inited, curId, owner, minter, forwardGas, salt) = loadData();
    assert(inited, not_inited);

    var gasFee = forwardGas > 0 ? calculateGasFee(MY_WORKCHAIN, forwardGas) : 0;
    return (forwardGas, gasFee);
}
