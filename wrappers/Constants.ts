export const Ops = {
    minter: {
       deploy_wallet: 0x4f5f4313,
       provide_wallet_address: 0x2c76b973,
       take_wallet_address: 0xd1735400,
       drop_admin: 0x7431f221,
       change_content: 0xcb862902
    },

    wallet: {
       internal_deploy: 0x6540cf85,
       transfer_notification: 0x7362d09c,
       transfer: 0x0f8a7ea5,
       ec_transfer : 0x1f3835d,
       excesses: 0xd53276db,
       ton_refund: 0xae25d79e,
       update_forward_gas: 123,
       withdraw_extra: 345
    }
}
export const ECErrors = {
   invalid_message : 100,
   invalid_address : 101,
   invalid_amount  : 103,
   wrong_workchain : 200,
   already_inited  : 300,
   not_inited      : 301,
   not_enough_gas  : 400,
   not_enough_ec_balance : 401,
   invalid_sender  : 500
}
