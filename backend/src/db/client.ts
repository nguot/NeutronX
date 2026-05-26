import { Pool } from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

export const db = new Pool({
  connectionString: process.env.DATABASE_URL
})