import express from 'express'
import cors from 'cors'
import * as dotenv from 'dotenv'
import ordersRouter   from './routes/orders'
import fillsRouter    from './routes/fills'
import simulateRouter from './routes/simulate'
import { startFallbackWatcher } from './watcher/fallbackWatcher'
import { startIndexer } from './indexer/eventIndexer'
dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

app.use('/orders',   ordersRouter)
app.use('/fills',    fillsRouter)
app.use('/simulate', simulateRouter)

app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`)
    startIndexer()
    startFallbackWatcher()
})