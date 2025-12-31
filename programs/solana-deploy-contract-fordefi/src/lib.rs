use anchor_lang::prelude::*;

declare_id!("GQxHpCW7Uv7DS2LxLS9sh7Tkstug27Ho14JiZTFJ3n2H");

#[program]
pub mod solana_deploy_contract_fordefi {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from Fordefi! {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
