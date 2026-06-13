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
import { startFallbackWatcher }   from './watcher/fallbackWatcher'
import { startIndexer }           from './indexer/eventIndexer'
import { startChainBWatcher }     from './chain/chainBWatcher'
import { initCrossChainSchema }   from './services/crosschainService'
import { initTokenSchema }        from './services/tokenService'
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

app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
    console.log(`Backend running on port ${PORT}`)
    await initTokenSchema()
    await initCrossChainSchema()
    startIndexer()
    startFallbackWatcher()
    startChainBWatcher()
})