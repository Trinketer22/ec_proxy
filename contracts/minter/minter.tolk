import "../helpers/messages.tolk"
import "../helpers/workchain.tolk"
import "../helpers/errors.tolk"
import "../helpers/jetton-utils.tolk"
import "op-codes.tolk"
import "storage.tolk"
import "@stdlib/tvm-dicts"

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
	var cs    = msgFull.beginParse();
	var flags = cs.loadMessageFlags();

	if(isMessageBounced(flags) || msgBody.isEndOfSlice()) {
		return;
	}

  var senderAddress = cs.loadAddress();
	var op: int = msgBody.loadUint(32);
	var queryId: int = msgBody.loadUint(64);


	loadData();

  if(op == deploy_wallet) {

    reserveToncoinsOnBalance(ONE_TON / 10, RESERVE_REGULAR); // reserve for storage fees
    /*
    deploy_wallet#4f5f4313
    query_id:uint64
    owner_address:MsgAddress
    excesses_address:MsgAddress
    forward_amount: Coins
    = InternalMsgBody;
    */

    var owner    = msgBody.loadAddress();
    var excessTo = msgBody.loadAddress();
    var forwardAmount = msgBody.loadCoins();

    var newWalletState = calculateJettonWalletStateInit(
            curId,
            owner,
            getMyAddress(),
            walletCode
    );

    var newWalletAddress = calculateJettonWalletAddress(newWalletState);

    var msgBody = beginCell()
                    .storeUint(internal_deploy, 32)
                    .storeUint(queryId, 64)
                    .storeSlice(excessTo)
                    .storeCoins(forwardAmount)
    .endCell();

    var msg = beginCell()
    .storeMsgFlagsAndAddressNone(BOUNCEABLE)
    .storeSlice(newWalletAddress) // dest
    .storeCoins(0)
		.storeStateinitRefAndBodyRef(newWalletState, msgBody);

    sendRawMessage(msg.endCell(), SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    return;
  }
  if (op == provide_wallet_address) {
      // see provide_wallet_address TL-B layout in jetton.tlb
      var ownerAddress: slice = msgBody.loadAddress();
      var isIncludeAddress: int = msgBody.loadBool();
      msgBody.assertEndOfSlice();

      var includedAddress: cell = isIncludeAddress
      ? beginCell().storeSlice(ownerAddress).endCell()
      : null;

      // build MessageRelaxed, see TL-B layout in stdlib.fc#L733
      var msg = beginCell()
      .storeMsgFlagsAndAddressNone(NON_BOUNCEABLE)
      .storeSlice(senderAddress)
      .storeCoins(0)
      .storePrefixOnlyBody()
      .storeUint(take_wallet_address, 32)
      .storeUint(queryId, 64);

      if (isSameWorkchain(ownerAddress)) {
          msg = msg.storeSlice(calculateUserJettonWalletAddress(curId, ownerAddress, getMyAddress(), walletCode));
      } else {
          msg = msg.storeAddressNone();
      }

      var msgCell: cell = msg.storeMaybeRef(includedAddress).endCell();

      sendRawMessage(msgCell, SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
      return;
  }
  if(op == change_content) {
    assert(isSliceBitsEqual(senderAddress, owner), invalid_sender);
    updateContent(msgBody.loadRef());
    msgBody.assertEndOfSlice();
    sendExcess(ONE_TON / 10, RESERVE_REGULAR, createEmptyDict(), excesses, queryId, 0, senderAddress);
    return;
  }
  if(op == drop_admin) {
    msgBody.assertEndOfSlice();
    assert(isSliceBitsEqual(senderAddress, owner), invalid_sender);
    dropAdmin();
    sendExcess(ONE_TON / 10, RESERVE_REGULAR, createEmptyDict(), excesses, queryId, 0, senderAddress);
    return;
  }
  throw 0xffff;
}

get get_jetton_data(): (int, int, slice, cell, cell) {
    loadData();
    return (0, true, owner, content, walletCode);
}

get get_jetton_data_extra(): (int, int, int, slice, cell, cell) {
    loadData();
    return (curId, 0, true, owner, content, walletCode);
}

get get_wallet_address(ownerAddress: slice): slice {
	loadData();
	return calculateUserJettonWalletAddress(curId, ownerAddress, getMyAddress(), walletCode);
}

