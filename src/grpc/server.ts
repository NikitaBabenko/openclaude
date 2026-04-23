import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'
import { randomUUID } from 'crypto'
import { QueryEngine } from '../QueryEngine.js'
import { getTools } from '../tools.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { AppState } from '../state/AppState.js'
import { FileStateCache, READ_FILE_STATE_CACHE_SIZE } from '../utils/fileStateCache.js'

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

const MAX_SESSIONS = 1000

export class GrpcServer {
  private server: grpc.Server
  private sessions: Map<string, any[]> = new Map()

  constructor() {
    this.server = new grpc.Server()
    this.server.addService(openclaudeProto.AgentService.service, {
      Chat: this.handleChat.bind(this),
    })
  }

  start(port: number = 50051, host: string = 'localhost') {
    this.server.bindAsync(
      `${host}:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) {
          console.error('Failed to start gRPC server')
          return
        }
        console.log(`gRPC Server running at ${host}:${boundPort}`)
      }
    )
  }

  private handleChat(call: grpc.ServerDuplexStream<any, any>) {
    let engine: QueryEngine | null = null
    let appState: AppState = getDefaultAppState()
    const fileCache: FileStateCache = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)

    // To handle ActionRequired (ask user for permission)
    const pendingRequests = new Map<string, (reply: string) => void>()

    // Accumulated messages from previous turns for multi-turn context
    let previousMessages: any[] = []
    let sessionId = ''
    let interrupted = false

    call.on('data', async (clientMessage) => {
      try {
        if (clientMessage.request) {
          if (engine) {
            call.write({
              error: {
                message: 'A request is already in progress on this stream',
                code: 'ALREADY_EXISTS'
              }
            })
            return
          }
          interrupted = false
          const req = clientMessage.request
          sessionId = req.session_id || ''
          previousMessages = []

          // Load previous messages from session store (cross-stream persistence)
          if (sessionId && this.sessions.has(sessionId)) {
            previousMessages = [...this.sessions.get(sessionId)!]
          }

          const toolNameById = new Map<string, string>()

          engine = new QueryEngine({
            cwd: req.working_directory || process.cwd(),
            tools: getTools(appState.toolPermissionContext), // Gets all available tools
            commands: [], // Slash commands
            mcpClients: [],
            agents: [],
            ...(previousMessages.length > 0 ? { initialMessages: previousMessages } : {}),
            includePartialMessages: true,
            canUseTool: async (tool, input, context, assistantMsg, toolUseID) => {
              if (toolUseID) {
                toolNameById.set(toolUseID, tool.name)
              }
              // Notify client of the tool call first
              call.write({
                tool_start: {
                  tool_name: tool.name,
                  arguments_json: JSON.stringify(input),
                  tool_use_id: toolUseID
                }
              })

              // Ask user for permission
              const promptId = randomUUID()
              const question = `Approve ${tool.name}?`
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
          })

          // Track accumulated response data for FinalResponse.
          // submitMessage() runs an agentic loop (LLM → tool call → tool result → next LLM call → ...),
          // so we receive multiple message_start/message_delta pairs — one per inner LLM turn.
          // We MUST sum across them; otherwise we only bill for the last turn and lose N-1 prior ones.
          let fullText = ''
          let promptTokens = 0
          let completionTokens = 0
          let costUsd = 0.0
          let innerCallCount = 0

          const generator = engine.submitMessage(req.message)

          for await (const msg of generator) {
            if (msg.type === 'stream_event') {
              const event = msg.event
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                call.write({
                  text_chunk: {
                    text: event.delta.text
                  }
                })
                fullText += event.delta.text
              }
              // Sum tokens and cost across every inner LLM call in the agentic loop.
              // Each chat/completions request to the provider produces its own message_start
              // and message_delta. Where the usage numbers actually live depends on the
              // backend:
              //   - Native Anthropic stream: message_start.message.usage carries
              //     input_tokens; message_delta.usage carries output_tokens.
              //   - OpenAI-compat shim (openaiShim.ts): message_start.message.usage is
              //     emitted with all zeros, and the FINAL message_delta carries BOTH
              //     input_tokens and output_tokens (plus OpenRouter's cost_usd when
              //     usage.include=true).
              // So we must read input/output from BOTH events and sum them, and we count
              // inner LLM calls via message_start (one per turn) regardless of whether
              // its usage block is populated. Using `+=` instead of `=` fixes the
              // "we only bill the last turn" cost-accounting bug.
              if (event.type === 'message_start') {
                innerCallCount += 1
                const u = (event as unknown as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage
                if (u?.input_tokens) promptTokens += u.input_tokens
                if (u?.output_tokens) completionTokens += u.output_tokens
              }
              if (event.type === 'message_delta') {
                const u = (event as unknown as { usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number } }).usage
                if (u?.input_tokens) promptTokens += u.input_tokens
                if (u?.output_tokens) completionTokens += u.output_tokens
                if (typeof u?.cost_usd === 'number' && u.cost_usd > 0) {
                  costUsd += u.cost_usd
                  console.log(
                    `[gRPC] inner LLM call #${innerCallCount}: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cost=$${u.cost_usd.toFixed(6)}`
                  )
                }
              }
            } else if (msg.type === 'user') {
              // Extract tool results
              const content = msg.message.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result') {
                    let outputStr = ''
                    if (typeof block.content === 'string') {
                      outputStr = block.content
                    } else if (Array.isArray(block.content)) {
                      outputStr = block.content.map(c => c.type === 'text' ? c.text : '').join('\n')
                    }
                    call.write({
                      tool_result: {
                        tool_name: toolNameById.get(block.tool_use_id) ?? block.tool_use_id,
                        tool_use_id: block.tool_use_id,
                        output: outputStr,
                        is_error: block.is_error || false
                      }
                    })
                  }
                }
              }
            } else if (msg.type === 'result') {
              // Extract final text from the result. Token/cost values are already
              // summed from per-inner-call stream events above (that is the
              // authoritative path). We only fall back to result.usage when the
              // stream path produced nothing at all — in which case result.usage
              // typically reflects only the last turn, which is better than zero
              // but understates the true cost of a multi-turn run. Never overwrite
              // already-accumulated non-zero values: that was the legacy bug.
              if (msg.subtype === 'success') {
                if (msg.result) {
                  fullText = msg.result
                }
                if (promptTokens === 0 && completionTokens === 0) {
                  promptTokens = msg.usage?.input_tokens ?? 0
                  completionTokens = msg.usage?.output_tokens ?? 0
                }
                if (costUsd === 0) {
                  costUsd = (msg.usage as unknown as { cost_usd?: number })?.cost_usd ?? 0.0
                }
              }
            }
          }

          if (!interrupted) {
            // Save messages for multi-turn context in subsequent requests
            previousMessages = [...engine.getMessages()]

            // Persist to session store for cross-stream resumption
            if (sessionId) {
              if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_SESSIONS) {
                // Evict oldest session (Map preserves insertion order)
                this.sessions.delete(this.sessions.keys().next().value)
              }
              this.sessions.set(sessionId, previousMessages)
            }

            // Diagnostic: billing depends on these aggregated token counts. If the Claude
            // API hands us back a success result with zero usage but non-empty text,
            // usage was dropped somewhere (tool-result-only turn that didn't hit the LLM,
            // OpenAI-shim bug, or provider that doesn't surface usage on streamed deltas).
            if (promptTokens === 0 && completionTokens === 0 && fullText && fullText.length > 0) {
              console.warn(
                `[gRPC] zero-token FinalResponse: session=${sessionId ?? 'anon'} text-len=${fullText.length} inner-calls=${innerCallCount}`
              )
            }
            console.log(
              `[gRPC] FinalResponse: session=${sessionId ?? 'anon'} inner-calls=${innerCallCount} prompt=${promptTokens} completion=${completionTokens} cost=$${costUsd.toFixed(6)}`
            )

            call.write({
              done: {
                full_text: fullText,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                cost_usd: costUsd
              }
            })

            // Close the server-side stream once the final response has been flushed.
            // Without this the client keeps its read loop open, which would hang the
            // task until its idle timeout and flip a successful run into a failure.
            call.end()
          }

          engine = null

        } else if (clientMessage.input) {
          const promptId = clientMessage.input.prompt_id
          const reply = clientMessage.input.reply
          if (pendingRequests.has(promptId)) {
            pendingRequests.get(promptId)!(reply)
            pendingRequests.delete(promptId)
          }
        } else if (clientMessage.cancel) {
          interrupted = true
          if (engine) {
            engine.interrupt()
          }
          call.end()
        }
      } catch (err: any) {
        console.error('Error processing stream')
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
      interrupted = true
      // Unblock any pending permission prompts so canUseTool can return
      for (const resolve of pendingRequests.values()) {
        resolve('no')
      }
      if (engine) {
        engine.interrupt()
      }
      engine = null
      pendingRequests.clear()
    })
  }
}
