import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'

const PROTO_PATH = path.resolve(import.meta.dirname, '../src/proto/openclaude.proto')

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
const openclaudeProto = protoDescriptor.openclaude.v1

async function main() {
  const client = new openclaudeProto.AgentService(
    'localhost:50051',
    grpc.credentials.createInsecure()
  )

  const call = client.Chat()

  call.on('data', (serverMessage: any) => {
    if (serverMessage.text_chunk) {
      process.stdout.write(serverMessage.text_chunk.text)
    } else if (serverMessage.tool_start) {
      console.log(`\n\n[🤖 АГЕНТ ВЫЗЫВАЕТ ИНСТРУМЕНТ: ${serverMessage.tool_start.tool_name}]`)
      console.log(`Аргументы: ${serverMessage.tool_start.arguments_json}\n`)
    } else if (serverMessage.tool_result) {
      console.log(`\n[✅ РЕЗУЛЬТАТ ИНСТРУМЕНТА: ${serverMessage.tool_result.tool_name}]`)
      console.log(serverMessage.tool_result.output)
    } else if (serverMessage.action_required) {
      const action = serverMessage.action_required
      console.log(`\n[⚠️ ТРЕБУЕТСЯ РАЗРЕШЕНИЕ: ${action.prompt_id}]`)
      console.log(action.question)
      
      // Автоматически отвечаем "yes" для теста
      console.log('-> Автоматически отправляем разрешение (yes)...')
      call.write({
        input: {
          prompt_id: action.prompt_id,
          reply: 'yes'
        }
      })
    } else if (serverMessage.done) {
      console.log('\n\n[🏁 ГЕНЕРАЦИЯ ЗАВЕРШЕНА]')
      process.exit(0)
    } else if (serverMessage.error) {
      console.error(`\n[❌ ОШИБКА СЕРВЕРА]: ${serverMessage.error.message}`)
      process.exit(1)
    }
  })

  call.on('end', () => {
    console.log('Стрим закрыт сервером.')
  })

  call.on('error', (err: Error) => {
    console.error('Ошибка стрима:', err)
  })

  // Инициируем запрос
  const initialRequest = {
    request: {
      session_id: 'test-session-123',
      message: 'Напиши короткую шутку про программистов. Используй русский язык.',
      working_directory: process.cwd()
    }
  }

  console.log('Отправляем запрос серверу...')
  call.write(initialRequest)
}

main()
