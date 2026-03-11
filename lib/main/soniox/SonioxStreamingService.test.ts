import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Handler = (...args: any[]) => void

class MockRealtimeSession {
  public handlers = new Map<string, Handler[]>()
  public connect = mock(async () => {})
  public sendAudio = mock((_chunk: Buffer) => {})
  public finish = mock(async () => {})
  public close = mock(() => {
    this.emit('disconnected', 'client_closed')
  })

  on(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args)
    }
  }
}

let latestSession: MockRealtimeSession | null = null

mock.module('@soniox/node', () => ({
  SonioxNodeClient: class MockSonioxNodeClient {
    realtime = {
      stt: () => {
        latestSession = new MockRealtimeSession()
        return latestSession
      },
    }
  },
}))

describe('SonioxStreamingService', () => {
  beforeEach(() => {
    latestSession = null
  })

  test('treats unexpected disconnect as an error', async () => {
    const { SonioxStreamingService } = await import('./SonioxStreamingService')

    const service = new SonioxStreamingService()
    const onError = mock()
    service.on('error', onError)

    await service.start('temp-key')

    latestSession!.emit('disconnected', 'idle_timeout')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]?.message).toContain('idle_timeout')
    expect(service.isCurrentlyActive()).toBe(false)
    expect(service.hasEncounteredError()).toBe(true)
  })

  test('ignores expected disconnect while stopping', async () => {
    const { SonioxStreamingService } = await import('./SonioxStreamingService')

    const service = new SonioxStreamingService()
    const onError = mock()
    service.on('error', onError)

    await service.start('temp-key')
    await service.stop()

    expect(latestSession!.finish).toHaveBeenCalledTimes(1)
    expect(latestSession!.close).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  test('suppresses error events during stop', async () => {
    const { SonioxStreamingService } = await import('./SonioxStreamingService')

    const service = new SonioxStreamingService()
    const onError = mock()
    service.on('error', onError)

    await service.start('temp-key')

    latestSession!.finish.mockImplementation(async () => {
      latestSession!.emit('error', new Error('ws closed during finish'))
    })

    await service.stop()

    expect(onError).not.toHaveBeenCalled()
  })
})
