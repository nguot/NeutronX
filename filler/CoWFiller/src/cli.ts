#!/usr/bin/env node
import { Command } from 'commander'
import {
  FILLER_NAME, renderOrders, renderBalances, renderSim, runFill,
  renderCcOrders, runCcFill, runCcClaim, runCcReset, runQuote, withWatch,
  resolveOrderHash, resolveCcOrderHash,
} from './cli/actions'
import { seedInventory } from './funding/seed'

const program = new Command()
program.name(FILLER_NAME.toLowerCase()).description(`NeutronX ${FILLER_NAME} dev CLI`).version('1.0.0')

program.command('orders').description('list open (pending + active) orders')
  .option('-w, --watch [seconds]', 'auto-refresh every N seconds (default 12)')
  .action(o => withWatch(o.watch === true ? 12 : o.watch ? Number(o.watch) : undefined, renderOrders))

program.command('balances').description('show wallet balances on every configured chain')
  .action(renderBalances)

program.command('sim <hash>').description('dry-run a fill preview (no transaction) — accepts a hash prefix')
  .option('-p, --pct <n>', 'percent of remaining to fill', '50')
  .action(async (hash, o) => renderSim(await resolveOrderHash(hash), Number(o.pct)))

program.command('fill <hash>').description('execute a partial fill — accepts a hash prefix')
  .option('-p, --pct <n>', 'percent of remaining to fill', '100')
  .action(async (hash, o) => runFill(await resolveOrderHash(hash), Number(o.pct)))

const cc = program.command('cc').description('cross-chain (Merkle-slot) operations')
cc.command('list').description('list cross-chain orders and their slots')
  .option('-w, --watch [seconds]', 'auto-refresh every N seconds (default 15)')
  .action(o => withWatch(o.watch === true ? 15 : o.watch ? Number(o.watch) : undefined, renderCcOrders))
cc.command('fill <hash> <slot>').description('fill a cross-chain slot (deploy dst escrow → withdraw on src)')
  .action(async (hash, slot) => runCcFill(await resolveCcOrderHash(hash), Number(slot)))
cc.command('claim <hash> <slot>').description('recover a slot the backend already claimed (withdraw on src)')
  .action(async (hash, slot) => runCcClaim(await resolveCcOrderHash(hash), Number(slot)))
cc.command('reset <hash> <slot>').description('reset a stuck locked slot back to available')
  .action(async (hash, slot) => runCcReset(await resolveCcOrderHash(hash), Number(slot)))

program.command('quote').description('run the fill strategy against an ad-hoc order (parity with /quote)')
  .requiredOption('--in <addr>', 'input token address')
  .requiredOption('--out <addr>', 'output token address')
  .requiredOption('--amount <wei>', 'input amount (wei)')
  .requiredOption('--start-price <raw>', '1e18-scaled start price')
  .requiredOption('--decay <n>', 'decay per block')
  .option('--min-fill-bps <n>', 'minimum fill bps', '100')
  .option('--deadline <block>', 'deadline block')
  .option('--fee-tier <n>', 'uniswap fee tier', '500')
  .action(runQuote)

program.command('seed').description('dev-only: seed wallet inventory on all chains')
  .action(async () => { await seedInventory(); process.exit(0) })

program.parseAsync(process.argv)
