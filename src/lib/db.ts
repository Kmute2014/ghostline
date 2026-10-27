import { PrismaClient } from '@prisma/client'
import { IpAddressTypes } from '@google-cloud/cloud-sql-connector'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  cloudSqlConnector: import('@google-cloud/cloud-sql-connector').Connector | undefined
}

async function createPrismaClient(): Promise<PrismaClient> {
  const instanceConnectionName = process.env.CLOUD_SQL_CONNECTION_NAME
  const log = ['error', 'warn'] as const

  if (!instanceConnectionName) {
    return new PrismaClient({ log: [...log] })
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set when CLOUD_SQL_CONNECTION_NAME is configured.')
  }

  const parsedUrl = new URL(databaseUrl)
  const connectorModule = await import('@google-cloud/cloud-sql-connector')
  const { Pool } = await import('pg')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const connector = new connectorModule.Connector()
  const connectorOptions = await connector.getOptions({
    instanceConnectionName,
    ipType: IpAddressTypes.PUBLIC,
  })

  globalForPrisma.cloudSqlConnector = connector

  const pool = new Pool({
    ...connectorOptions,
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
    database: decodeURIComponent(parsedUrl.pathname.slice(1)),
    max: 5,
  })

  return new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [...log],
  })
}

export const db = globalForPrisma.prisma ?? (await createPrismaClient())

globalForPrisma.prisma = db
