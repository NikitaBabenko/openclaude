import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'
import { randomUUID } from 'crypto'
import { QueryEngine } from '../QueryEngine.js'
import { getTools } from '../tools.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { AppState } from '../state/AppState.js'
import { FileStateCache } from '../utils/fileStateCache.js'

const PROTO_PATH = path.resolve(import.meta.dirname, '../proto/openclaude.proto')

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
const openclaudeProto = protoDescriptor.openclaude.v1

export class GrpcServer {
  private server: grpc.Server

  constructor() {
    this.server = new grpc.Server()
    this.server.addService(openclaudeProto.AgentService.service, {
      Chat: this.handleChat.bind(this),
    })
  }

  start(port: number = 50051) {
    this.server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) {
          console.error('Failed to start gRPC server', error)
          return
        }
        console.log(`gRPC Server running at 0.0.0.0:${boundPort}`)
      }
    )
  }

  private handleChat(call: grpc.ServerDuplexStream<any, any>) {
    let engine: QueryEngine | null = null
    let appState: AppState = getDefaultAppState()
    const fileCache: FileStateCache = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
    
    // To handle ActionRequired (ask user for permission)
    const pendingRequests = new Map<string, (reply: string) => void>()

    call.on('data', async (clientMessage) => {
      try {
        if (clientMessage.request) {
          const req = clientMessage.request
          
          engine = new QueryEngine({
            cwd: req.working_directory || process.cwd(),
            tools: getTools(), // Gets all available tools
            commands: [], // Slash commands
            mcpClients: [],
            agents: [],
            canUseTool: async (tool, input, context, assistantMsg, toolUseID) => {
              // Ask user for permission
              const promptId = randomUUID()
              
              const question = `Tool call: ${tool.name}\nArgs: ${JSON.stringify(input)}`
              call.write({
                action_required: {
                  prompt_id: promptId,
                  question,
                  type: 'CONFIRM_COMMAND'
                }
              })

              return new Promise((resolve) => {
                pendingRequests.set(promptId, (reply) => {
                  if (reply.toLowerCase() === 'yes' || reply.toLowerCase() === 'y') {
                    resolve({ behavior: 'allow' })
                  } else {
                    resolve({ behavior: 'deny', reason: 'User denied via gRPC' })
                  }
                })
              })
            },
            getAppState: () => appState,
            setAppState: (updater) => { appState = updater(appState) },
            readFileCache: fileCache,
            userSpecifiedModel: req.model,
            fallbackModel: req.model,
            // Configure provider inside AppState or env variables beforehand
          })

          const generator = engine.submitMessage(req.message)

          for await (const msg of generator) {
            // Map SDKMessage from internal representation to gRPC ServerMessage
            if (msg.type === 'tool_use' && msg.name === 'local_command') {
              call.write({
                tool_start: {
                  tool_name: msg.name,
                  arguments_json: JSON.stringify(msg.input)
                }
              })
            } else if (msg.type === 'tool_result' && msg.tool_name === 'local_command') {
               call.write({
                tool_result: {
                  tool_name: msg.tool_name,
                  output: msg.content.map((c: any) => c.text).join('\n'),
                  is_error: msg.is_error || false
                }
              })
            } else if (msg.type === 'text' && msg.text) {
              call.write({
                text_chunk: {
                  text: msg.text
                }
              })
            }
          }

          call.write({
            done: {
              full_text: "Generation complete.",
              prompt_tokens: 0,
              completion_tokens: 0
            }
          })
          call.end()

        } else if (clientMessage.input) {
          const promptId = clientMessage.input.prompt_id
          const reply = clientMessage.input.reply
          if (pendingRequests.has(promptId)) {
            pendingRequests.get(promptId)!(reply)
            pendingRequests.delete(promptId)
          }
        } else if (clientMessage.cancel) {
          // Implement cancellation logic if needed
          call.end()
        }
      } catch (err: any) {
        console.error("Error processing stream:", err)
        call.write({
          error: {
            message: err.message || "Internal server error",
            code: "INTERNAL"
          }
        })
        call.end()
      }
    })

    call.on('end', () => {
      // Client closed the stream
      engine = null
      pendingRequests.clear()
    })
  }
}
