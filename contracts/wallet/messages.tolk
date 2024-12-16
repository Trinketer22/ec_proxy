import "../helpers/ec_helpers.tolk";
import "../helpers/messages.tolk";
import "../helpers/errors.tolk";
import "op-codes.tolk";
import "gas.tolk";

@inline
fun sendNotification(queryId: int, amount: int, from: slice, owner: slice, forwardPayload: slice, tonAmount: int) {
  var msgBody   = beginCell()
                    .storeUint(transfer_notification, 32) // 32
                    .storeUint(queryId, 64) // 64
                    .storeCoins(amount) // 124
                    .storeSlice(from) // 267
                    .storeSlice(forwardPayload)
                  .endCell();

  var msg: cell = beginCell()
                    .storeMsgFlagsAndAddressNone(NON_BOUNCEABLE)
                    .storeSlice(owner)
                    .storeCoins(tonAmount)
                    .storeOnlyBodyRef(msgBody)
                  .endCell();
  
  sendRawMessage(msg, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

@inline
fun sendEcTransfer(ec: cell, transferTon: int, fwdTonAmount: int, queryId: int, dst: slice, refund: slice, forwardPayload: slice) {
  var msgBody = beginCell()
                  .storeUint(ec_transfer, 32)
                  .storeUint(queryId, 64)
                  .storeCoins(fwdTonAmount)
                  .storeSlice(refund)
                  .storeSlice(forwardPayload)
                .endCell();
  var msg = beginCell()
              .storeMsgFlagsAndAddressNone(BOUNCEABLE)
              .storeSlice(dst)
              .storeCoins(transferTon + fwdTonAmount)
              .storeBodyRefWithEc(msgBody, ec)
            .endCell();
  
  sendRawMessage(msg, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
