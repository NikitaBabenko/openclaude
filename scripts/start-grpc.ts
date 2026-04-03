import { GrpcServer } from '../src/grpc/server.ts'
import { loadAllPluginsCacheOnly } from '../src/utils/plugins/pluginLoader.js'
import { getGlobalConfig } from '../src/utils/config.js'

async function main() {
  console.log('Starting OpenClaude gRPC Server...')

  // Load plugins if necessary before starting the engine (similar to CLI entrypoint)
  try {
    await loadAllPluginsCacheOnly(getGlobalConfig())
  } catch (error) {
    console.warn('Failed to load plugins:', error)
  }

  const port = process.env.GRPC_PORT ? parseInt(process.env.GRPC_PORT, 10) : 50051
  const server = new GrpcServer()
  
  server.start(port)
}

main().catch((err) => {
  console.error('Fatal error starting gRPC server:', err)
  process.exit(1)
})
