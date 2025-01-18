export const Ops = {
    minter: {
       deploy_wallet: 0xad9d230a,
       provide_wallet_address: 0x2c76b973,
       take_wallet_address: 0xd1735400,
       drop_admin: 0x67a18fb6,
       change_content: 0x5ecabd5c
    },

    wallet: {
       internal_deploy : 0xa97ca079,
       excesses : 0xd53276db,
       transfer_notification : 0x7362d09c,
       ton_refund : 0xe41f7d83,
       ec_transfer : 0x68039ead,
       transfer : 0x0f8a7ea5,
       update_proxy_options: 0xe87b5bd5,
       withdraw_extra : 0x7ad2441e
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
   not_enough_balance: 402,
   invalid_sender  : 500
}
