import express from 'express'
import cors from 'cors'
import * as dotenv from 'dotenv'
import ordersRouter      from './routes/orders'
import fillsRouter       from './routes/fills'
import simulateRouter    from './routes/simulate'
import crosschainRouter  from './routes/crosschain'
import adminRouter       from './routes/admin'
import quoteRouter       from './routes/quote'
import suggestRouter     from './routes/suggest'
import tokensRouter      from './routes/tokens'
import aggregatorsRouter from './routes/aggregators'
import fallbackRouter    from './routes/fallback'
import stakeConfigRouter from './routes/stakeConfig'
import { startFallbackWatcher }   from './watcher/fallbackWatcher'
import { startExpiryWatcher }     from './watcher/expiryWatcher'
import { startIndexer }           from './indexer/eventIndexer'
import { startStakeConfigIndexer } from './indexer/stakeConfigIndexer'
import { startRegistrationIndexer } from './indexer/registrationIndexer'
import { startEscrowDstWatcher }  from './chain/escrowDstWatcher'
import { startEscrowSrcWatcher }  from './chain/escrowSrcWatcher'
import { initCrossChainSchema }   from './services/crosschainService'
import { initTokenSchema }        from './services/tokenService'
import { initFillerSchema }       from './services/fillerRegistry'
import { loadChainRegistry }      from './config/chains'
dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

app.use('/orders',   ordersRouter)
app.use('/fills',    fillsRouter)
app.use('/simulate', simulateRouter)
app.use('/cc',       crosschainRouter)
app.use('/admin',    adminRouter)
app.use('/quote',    quoteRouter)
app.use('/suggest-params', suggestRouter)
app.use('/tokens',   tokensRouter)
app.use('/aggregators', aggregatorsRouter)
app.use('/fallback', fallbackRouter)
app.use('/stake-config', stakeConfigRouter)

app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
    console.log(`Backend running on port ${PORT}`)
    await initTokenSchema()
    await initCrossChainSchema()
    await initFillerSchema()
    startIndexer()
    startStakeConfigIndexer()
    startRegistrationIndexer()
    startFallbackWatcher()
    startExpiryWatcher()
    // One watcher per registry chain, watching that chain's EscrowDstFactory —
    // fillers settle here whenever this chain is an order's destination.
    for (const chain of loadChainRegistry()) {
        startEscrowDstWatcher({
            chainId:       chain.id,
            rpc:           chain.rpc,
            factoryAddr:   chain.escrowDstFactory,
            confirmations: chain.confirmations,
            label:         chain.name,
        })
    }
    // One watcher per registry chain, watching that chain's EscrowSrcFactory —
    // records the filler address on a slot as soon as it claims it, so fillers
    // no longer need to self-report via PATCH .../slots/:index/filler.
    for (const chain of loadChainRegistry()) {
        startEscrowSrcWatcher({
            chainId:     chain.id,
            rpc:         chain.rpc,
            factoryAddr: chain.escrowSrcFactory,
            label:       chain.name,
        })
    }
})