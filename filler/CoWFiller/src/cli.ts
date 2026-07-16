#!/usr/bin/env node
import { Command } from 'commander'
import {
  FILLER_NAME, renderOrders, renderBalances, renderSim, runFill,
  renderCcOrders, runCcFill, runCcResume, runQuote, withWatch,
  resolveOrderHash, resolveCcOrderHash, shutdownFiller,
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

const cc = program.command('cc').description('cross-chain (filler-holds-key, continuous fill) operations')
cc.command('list').description('list cross-chain orders and their fills')
  .option('-w, --watch [seconds]', 'auto-refresh every N seconds (default 15)')
  .action(o => withWatch(o.watch === true ? 15 : o.watch ? Number(o.watch) : undefined, renderCcOrders))
cc.command('fill <hash> <pct>').description('start a new fill for <pct>% of what\'s still fillable (fund dst → wait swapper → lock src → reveal)')
  .option('--min-margin-sec <n>', 'required time margin (sec) before T1 to create EscrowSrc / reveal — aborts if tighter', '60')
  .option('--force', 'skip the T1 margin check and proceed even if T1 is dangerously close')
  .action(async (hash, pct, o) => runCcFill(await resolveCcOrderHash(hash), Number(pct),
    { minMarginSeconds: Number(o.minMarginSec), force: !!o.force }))
cc.command('resume <hash> <fillId>').description('resume an in-flight fill after a crash/restart (uses the locally-saved secret)')
  .option('--min-margin-sec <n>', 'required time margin (sec) before T1 to create EscrowSrc / reveal — aborts if tighter', '60')
  .option('--force', 'skip the T1 margin check and proceed even if T1 is dangerously close')
  .action(async (hash, fillId, o) => runCcResume(await resolveCcOrderHash(hash), Number(fillId),
    { minMarginSeconds: Number(o.minMarginSec), force: !!o.force }))

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

program.command('shutdown').description('stop the running watcher (npm start process)')
  .action(shutdownFiller)

program.parseAsync(process.argv)
