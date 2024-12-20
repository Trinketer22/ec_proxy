# Extra currency proxy wallet

Purpose of this contract is to provide
[jetton](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) compatible interface to [extra currency](https://docs.ton.org/v3/documentation/dapps/defi/coins#extra-currencies).  

Implemented in [TOLK](https://docs.ton.org/v3/documentation/smart-contracts/tolk/overview) and inspired by [PTON](https://github.com/ston-fi/TEPs/blob/master/text/0161-pton-standard.md) standard.

## Wallet

### Storage parameters

Wallet storage has the following layout:

```
wallet_storage$_
inited:Bool // Indicates post-deployemnt intialization
currency_id:uint32 // EC id
owner:MsgAddress // wallet owner address
minter:MsgAddress // wallet minter address
forward_gas:Coins // Amount of gas units to forward to the owner
salt:uint13 // Salt used for shard optimizations
```

Further in text, data fields will be referenced in `following` styling.

### Incoming transfer

Wallet accepts arbitrary non-empty(>= 32 bit length body) internal message containing EC with matching `currency_id` and value > 0.
In case such message doesn't contain any know op-code and carries enough gas,
jetton transfer notification will be passed to the `owner` of the wallet.  

```
transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16)
                              sender:MsgAddress forward_payload:(Either Cell ^Cell)
                              = InternalMsgBody;
```

- `amount` will carry the incoming *EC* amount
- `sender` the source address of the incoming message
- `forward_payload` will contain incoming message full body

Forward ton amount will be determined by the state parameter `forward_gas`.  
**NOTE** that `forward_gas` is nominated in gas units, so final ton amount 
will be calculated using gas price [formula](https://docs.ton.org/v3/documentation/smart-contracts/transaction-fees/fees-low-level#gas).
In case `fowrard_gas_amount` equals 0, no value will be attached to the notification
which is normal in case no computation is expected on the `owner` address.
All of the EC with matching `currency_id` is kept on the balance, while excess TON and EC(if any) is returned to sender.

#### Full format transfer

It is possible to tune the receiving wallet behavior using the following message:

```
ec_transfer#68039ead forward_gas:Coins
refund:MsgAddress
forward_payload:(Either Cell ^Cell)
= InternalMsgBody;
```

In that case:

- `forward_gas` amount of TON is attached to the notification
- If `refund` contains standard address, Excess/error refund is sent to it
- `forward_payload` is passed as notification payload


#### Error handling

In case of full format transfer message being malformed, message will bounce  
In case of any other errors during processing, the `ton_refund` message carrying excess TON and all incoming EC will be sent to the sender or `refund` address if specified.

```
ton_refund#e41f7d83 query_id:uint64 error:uint10 = InternalMsgBody;

```

`error` field indicates error code.

In case of success, EC with matching `currency_id` is kept on balance,
and  excess TON and EC returned to sender or `refund` address
via excess message:

```
// Compatible with jetton https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md#tl-b-schema
excesses#d53276db query_id:uint64 = InternalMsgBody;

```

### Outgoing transfer

In order to send EC from the wallet, `owner` should send to it the transfer
message from jetton standard:

```
// Compatible with jetton https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md#tl-b-schema
transfer#0xf8a7ea5 query_id:uint64 amount:(VarUInteger 16) destination:MsgAddress
response_destination:MsgAddress custom_payload:(Maybe ^Cell)
forward_ton_amount:(VarUInteger 16) forward_payload:(Either Cell ^Cell) = InternalMsgBody;

```

As a result of successful transfer, outgoing message, carrying EC
will be sent in format of [Full format transfer](#full-format-transfer)

Where fields of `transfer` message map to the `ec_transfer` as following:

- `amount` specifies amount of outgoing EC with `currency_id`
- `destination` standard destination address
- `response_destination` If standard, maps to `refund` address
- `custom_payload` is ignored
- `forward_ton_amount` maps to `forward_gas`
- `forward_payload` maps to `forward_payload`

in case `forward_ton_amount` greater than 0,
contract will attach `forward_ton_amount` + enough ton or another EC proxy wallet
`ec_transfer` execution, or `forward_gas` in case it exceeds this amount.  
In short:
`total_forward_ton = forward_ton_amount + max(forward_gas, TRANSFER_GAS)`

Point is to be able to send from one EC proxy wallet
to another and expect it to forward `forward_ton_amount` with notification to
it's owner.  
In case of `forward_ton_amount` equals 0, `forward_gas` is attached.  
Excesses returned to either `refund` address(if specified) or sender address.

#### Error handling

In case of error during processing transfer request,
message is bounced back to sender.
Rest of the chain is described by [Full format transfer](#full-format-transfer)

### Forward gas

Ratio behind the `forward_gas` field is to allow gas control on behalf of the
owner contract on the proxy wallet level.  
Value is specified in gas units and later converted to TON during the execution.

#### Get forward gas value

There is a get method available to retrieve `forward_gas` amount with
it's ton value - `get_forward_gas(): (gas_amount: int, ton_value: int)`.
`ton_value` being a total cost of `gas_amount` gas units.

#### Set forward gas value

In order to set `forward_gas` value, owner should send  `update_forward_gas`
message:

```
update_forward_gas#f6f24f33 query_id:uint64
forward_gas:Coins = InternalMsgBody;
```
Where `forward_gas` is gas units value.

#### Withdraw stuck assets

There are some unfortunate situations possible, where
assets get stuck on the contract address.
For instance sending malformed message in non_bounceable mode or
message carrying not enough value to send refund message back.  

In order to resolve consequences of such situations, owner could send `withdraw_extra` message:

```
_withdraw_id:uint32 = WithdrawSpecific;

withdraw_extra#7ad2441e query_id:uint64
specific:(Maybe WithdrawSpecific)
from_balance_amount:Coins
to:MsgAddress = InternalMsgBody;
```

- `specific` if maybe flag set, specifies currency id to withdraw.
- `from_balance` specifies amount of TON to withdraw from the wallet balance.
- `to` specifies the destination address to send to.

There is specific and non-specific modes of this operation.  
In non-specific mode, contract releases all of the EC's available except
`currency_id`,  and send all of those to the destination address.  
In specific mode, owner could specify exact currency id to withdraw. 

**KEEP IN MIND** that among with the `from_balance` value, all of the incoming
value is send to the destination address.

## Minter

### State layout

```
_state
currency_id:uint32
owner:MessageAddress
wallet_code:^Cell
content:^Cell
```

- `currency_id` Index of a currency in `extra_currencies` [dictionary](https://docs.ton.org/v3/documentation/infra/minter-flow#extracurrency) which get's propagated to the newly created wallets
- `owner` admin of the minter contract
- `wallet_code` code of the wallet contract
- `content` cell containing meta info (presumably coded in [jetton data standard](https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md))

### Deploying new wallet

In order to deploy new wallet, user should send  following message to the
*minter* contract address:

```
deploy_wallet#44bb3e46 query_id:uint64
owner:MsgAddress
refund:MsgAddress
forwardGas:Coins = InternalMsgBody;
```

`refund` address is used to return excesses from the new wallet address,
rest of the fields map to the wallet state field accordingly.

### Wallet discovery

Contract supports wallet discovery using [TEP89](https://github.com/ton-blockchain/TEPs/blob/master/text/0089-jetton-wallet-discovery.md) protocol

### Shard optimizations

Current version of a contract supports on-chain
[shard optimization](https://github.com/ton-blockchain/TEPs/blob/master/text/0089-jetton-wallet-discovery.md) putting newly deployed wallet into the
same shard as it's `owner` address.  
This feature increases costs of `deploy_wallet` and discovery(`provide_wallet_address`)
operations due to state init bruteforce.

On average, discovery consumes about 17K gas + forward fee
`0.008` in TON. However, worst case scenario, if all 128
bruteforce attempts used, computation cost is 91K gas + forward fee.
Recommended value for discovery is 0.05 TON at current config values  
If discovery costs are important for your project, one may decrease
the [iterations number](https://github.com/Trinketer22/ec_proxy/blob/main/contracts/helpers/jetton-utils.tolk#L6).  
For the reference, 128 iterations finds same shard combination in 99% of the time,
while 32 iterations give result int 86% of a time at a quarter of a cost.

### Admin operations

#### Changing content

Admin is able to change content after deployent by sending:

```
change_content#5ecabd5c queryId:uint64 content: ^Cell = InternalMsgBody;
```

where `content` should contain new content cell.

#### Drop admin

Minter admin is able to drop it's rights, leaving minter content static
forever.

```
drop_admin#67a18fb6 queryId:uint64 = InternalMsgBody;
```
