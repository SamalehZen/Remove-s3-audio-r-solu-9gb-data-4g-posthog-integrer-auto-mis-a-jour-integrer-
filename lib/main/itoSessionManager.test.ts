import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { ItoMode } from '@/app/generated/ito_pb'
import { createMockTimingCollector } from '../__tests__/setup'
import { TimingEventName } from './timing/TimingCollector'

const mockTimingCollector = createMockTimingCollector()
mock.module('./timing/TimingCollector', () => ({
  timingCollector: mockTimingCollector,
  TimingEventName: TimingEventName,
}))

const mockVoiceInputService = {
  startAudioRecording: mock(() => Promise.resolve()),
  stopAudioRecording: mock(() => Promise.resolve()),
}
mock.module('./voiceInputService', () => ({
  voiceInputService: mockVoiceInputService,
}))

const mockRecordingStateNotifier = {
  notifyRecordingStarted: mock(),
  notifyRecordingStopped: mock(),
  notifyProcessingStarted: mock(),
  notifyProcessingStopped: mock(),
}
mock.module('./recordingStateNotifier', () => ({
  recordingStateNotifier: mockRecordingStateNotifier,
}))

const mockItoStreamController = {
  initialize: mock(_mode => Promise.resolve(true)),
  startGrpcStream: mock(() =>
    Promise.resolve({
      response: { transcript: 'test transcript' },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    }),
  ),
  setMode: mock(),
  getCurrentMode: mock(() => ItoMode.TRANSCRIBE),
  scheduleConfigUpdate: mock(() => Promise.resolve()),
  getAudioDurationMs: mock(() => 1000),
  endInteraction: mock(),
  cancelTranscription: mock(),
  clearInteractionAudio: mock(),
}
mock.module('./itoStreamController', () => ({
  itoStreamController: mockItoStreamController,
}))

const mockTextInserter = {
  insertText: mock(() => Promise.resolve(true)),
}
mock.module('./text/TextInserter', () => ({
  TextInserter: class MockTextInserter {
    insertText = mockTextInserter.insertText
  },
}))

const mockInteractionManager = {
  getCurrentInteractionId: mock((): string | null => null),
  adoptInteractionId: mock(),
  initialize: mock(() => 'test-interaction-123'),
  createInteraction: mock(() => Promise.resolve()),
  clearCurrentInteraction: mock(),
}
mock.module('./interactions/InteractionManager', () => ({
  interactionManager: mockInteractionManager,
}))

const mockContextGrabber = {
  gatherContext: mock(() =>
    Promise.resolve({
      windowTitle: 'Test Window',
      appName: 'Test App',
      contextText: 'Test context',
      vocabularyWords: ['test', 'word'],
      replacements: [],
      userDetails: null,
      browserUrl: null,
      browserDomain: null,
      tone: null,
      advancedSettings: {
        llm: {
          asrModel: 'whisper-1',
          asrProvider: 'openai',
          asrPrompt: '',
          noSpeechThreshold: 0.5,
          llmProvider: 'openai',
          llmModel: 'gpt-4',
          llmTemperature: 0.7,
          transcriptionPrompt: '',
          editingPrompt: '',
        },
        grammarServiceEnabled: false,
        macosAccessibilityContextEnabled: true,
      },
      screenCaptureBase64: null,
      screenThumbnailBase64: null,
      screenCaptureMimeType: null,
      contextSource: null,
    }),
  ),
  getCursorContextForGrammar: mock(() => Promise.resolve('test context')),
  setCustomModePrompt: mock(),
}
mock.module('./context/ContextGrabber', () => ({
  contextGrabber: mockContextGrabber,
}))

const mockGrammarRulesService = {
  setCaseFirstWord: mock((text: string) => text),
  addLeadingSpaceIfNeeded: mock((text: string) => text),
}
mock.module('./grammar/GrammarRulesService', () => ({
  GrammarRulesService: class MockGrammarRulesService {
    setCaseFirstWord = mockGrammarRulesService.setCaseFirstWord
    addLeadingSpaceIfNeeded = mockGrammarRulesService.addLeadingSpaceIfNeeded
  },
}))

const mockGetAdvancedSettings = mock(() => ({
  grammarServiceEnabled: false,
}))
mock.module('./store', () => ({
  getAdvancedSettings: mockGetAdvancedSettings,
  getCurrentUserId: mock(() => 'test-user-id'),
  store: {
    get: mock(() => ({})),
  },
}))

mock.module('electron-log', () => ({
  default: {
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}))

const mockSonioxTempKeyManager = {
  getKey: mock(() => Promise.resolve('test-soniox-key')),
  warmup: mock(() => Promise.resolve()),
  invalidate: mock(),
}
mock.module('./soniox/SonioxTempKeyManager', () => ({
  sonioxTempKeyManager: mockSonioxTempKeyManager,
}))

const mockSonioxPersistentSession = {
  ensureReady: mock(() => Promise.resolve()),
  startStreaming: mock(),
  stopStreaming: mock(() => Promise.resolve({ text: 'raw soniox text', durationMs: 500, tokenCount: 10 })),
  sendAudio: mock(),
  close: mock(),
  getState: mock(() => 'paused'),
  getDiagnostics: mock(() => ({})),
  on: mock(),
  off: mock(),
  removeAllListeners: mock(),
  emit: mock(),
}
mock.module('./soniox/SonioxPersistentSession', () => ({
  SonioxPersistentSession: class MockSonioxPersistentSession {
    ensureReady = mockSonioxPersistentSession.ensureReady
    startStreaming = mockSonioxPersistentSession.startStreaming
    stopStreaming = mockSonioxPersistentSession.stopStreaming
    sendAudio = mockSonioxPersistentSession.sendAudio
    close = mockSonioxPersistentSession.close
    getState = mockSonioxPersistentSession.getState
    getDiagnostics = mockSonioxPersistentSession.getDiagnostics
    on = mockSonioxPersistentSession.on
    off = mockSonioxPersistentSession.off
    removeAllListeners = mockSonioxPersistentSession.removeAllListeners
    emit = mockSonioxPersistentSession.emit
  },
}))

const mockCustomModeResolver = {
  resolve: mock(() => Promise.resolve(null)),
}
mock.module('./context/CustomModeResolver', () => ({
  customModeResolver: mockCustomModeResolver,
}))

const mockActiveWindowMonitor = {
  getCachedState: mock(() => null),
}
mock.module('./ActiveWindowMonitor', () => ({
  activeWindowMonitor: mockActiveWindowMonitor,
}))

const mockAudioRecorderService = {
  on: mock(),
  off: mock(),
  stopRecording: mock(),
}
mock.module('../media/audio', () => ({
  audioRecorderService: mockAudioRecorderService,
}))

const mockItoHttpClient = {
  post: mock(() =>
    Promise.resolve({ success: true, transcript: 'adjusted transcript' }),
  ),
}
mock.module('../clients/itoHttpClient', () => ({
  itoHttpClient: mockItoHttpClient,
}))

beforeEach(() => {
  console.log = mock()
  console.error = mock()
})

describe('itoSessionManager', () => {
  beforeEach(() => {
    // Reset all mocks
    Object.values(mockVoiceInputService).forEach(mockFn => mockFn.mockClear())
    Object.values(mockRecordingStateNotifier).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockItoStreamController).forEach(mockFn => mockFn.mockClear())
    Object.values(mockTextInserter).forEach(mockFn => mockFn.mockClear())
    Object.values(mockInteractionManager).forEach(mockFn => mockFn.mockClear())
    Object.values(mockContextGrabber).forEach(mockFn => mockFn.mockClear())
    Object.values(mockGrammarRulesService).forEach(mockFn => mockFn.mockClear())
    Object.values(mockTimingCollector).forEach(mockFn => mockFn.mockClear())
    Object.values(mockSonioxTempKeyManager).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockSonioxPersistentSession).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockAudioRecorderService).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockItoHttpClient).forEach(mockFn => mockFn.mockClear())

    mockGetAdvancedSettings.mockClear()

    // Reset default behaviors
    mockItoStreamController.initialize.mockResolvedValue(true)
    mockItoStreamController.startGrpcStream.mockResolvedValue({
      response: { transcript: 'test transcript' },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })
    mockItoStreamController.getAudioDurationMs.mockReturnValue(1000)
    mockTextInserter.insertText.mockResolvedValue(true)
    mockInteractionManager.getCurrentInteractionId.mockReturnValue(null)
    mockInteractionManager.initialize.mockReturnValue('test-interaction-123')
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: false,
    })

    mockSonioxTempKeyManager.getKey.mockResolvedValue('test-soniox-key')
    mockSonioxPersistentSession.ensureReady.mockResolvedValue(undefined)
    mockSonioxPersistentSession.stopStreaming.mockResolvedValue({ text: 'raw soniox text', durationMs: 500, tokenCount: 10 })
    mockItoHttpClient.post.mockResolvedValue({
      success: true,
      transcript: 'adjusted transcript',
    })
  })

  test('should start session successfully', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)

    expect(mockItoStreamController.initialize).toHaveBeenCalledWith(
      ItoMode.TRANSCRIBE,
    )
    expect(mockItoStreamController.startGrpcStream).toHaveBeenCalled()
    expect(mockItoStreamController.setMode).toHaveBeenCalledWith(
      ItoMode.TRANSCRIBE,
    )
    expect(mockVoiceInputService.startAudioRecording).toHaveBeenCalled()
    expect(
      mockRecordingStateNotifier.notifyRecordingStarted,
    ).toHaveBeenCalledWith(ItoMode.TRANSCRIBE)
  })

  test('should fetch and send context in background', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)

    // Wait for background context fetch
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(mockItoStreamController.scheduleConfigUpdate).toHaveBeenCalled()
  })

  test('should fetch cursor context when grammar is enabled', async () => {
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: true,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)

    // Wait for background context fetch
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(mockContextGrabber.getCursorContextForGrammar).toHaveBeenCalledTimes(
      1,
    )
    expect(mockContextGrabber.getCursorContextForGrammar).toHaveBeenCalled()
  })

  test('should not fetch cursor context when grammar is disabled', async () => {
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: false,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)

    // Wait for background context fetch
    await new Promise(resolve => setTimeout(resolve, 50))
  })

  test('should fail to start session when controller fails', async () => {
    mockItoStreamController.initialize.mockResolvedValueOnce(false)

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)

    expect(mockVoiceInputService.startAudioRecording).not.toHaveBeenCalled()
  })

  test('should change mode during session', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    session.setMode(ItoMode.EDIT)

    expect(mockItoStreamController.setMode).toHaveBeenCalledWith(ItoMode.EDIT)
    expect(
      mockRecordingStateNotifier.notifyRecordingStarted,
    ).toHaveBeenCalledWith(ItoMode.EDIT)
  })

  test('should cancel session successfully', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.cancelSession()

    expect(mockItoStreamController.cancelTranscription).toHaveBeenCalled()
    expect(mockVoiceInputService.stopAudioRecording).toHaveBeenCalled()
    expect(mockRecordingStateNotifier.notifyRecordingStopped).toHaveBeenCalled()
  })

  test('should complete session with sufficient audio', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    mockItoStreamController.getAudioDurationMs.mockReturnValue(500)

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockVoiceInputService.stopAudioRecording).toHaveBeenCalled()
    expect(mockItoStreamController.endInteraction).toHaveBeenCalled()
    expect(mockRecordingStateNotifier.notifyRecordingStopped).toHaveBeenCalled()
  })

  test('should cancel session when audio too short', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    mockItoStreamController.getAudioDurationMs.mockReturnValue(50)

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockItoStreamController.cancelTranscription).toHaveBeenCalled()
    expect(mockItoStreamController.endInteraction).not.toHaveBeenCalled()
    expect(mockRecordingStateNotifier.notifyRecordingStopped).toHaveBeenCalled()
  })

  test('should handle successful transcription response', async () => {
    const mockTranscript = 'Hello world'
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: { transcript: mockTranscript },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockTextInserter.insertText).toHaveBeenCalledWith(mockTranscript)
    expect(mockInteractionManager.createInteraction).toHaveBeenCalledWith(
      mockTranscript,
      Buffer.from('audio-data'),
      16000,
      undefined,
    )
    expect(mockItoStreamController.endInteraction).toHaveBeenCalled()
    expect(mockInteractionManager.clearCurrentInteraction).toHaveBeenCalled()
  })

  test('should apply grammar rules when enabled', async () => {
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: true,
    })

    const mockTranscript = 'hello world'
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: { transcript: mockTranscript },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    mockGrammarRulesService.setCaseFirstWord.mockReturnValue('Hello world')
    mockGrammarRulesService.addLeadingSpaceIfNeeded.mockReturnValue(
      ' Hello world',
    )

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    // Allow background context fetch to set up grammarRulesService
    await new Promise(resolve => setTimeout(resolve, 60))
    await session.completeSession()

    expect(mockGrammarRulesService.setCaseFirstWord).toHaveBeenCalledWith(
      mockTranscript,
    )
    expect(
      mockGrammarRulesService.addLeadingSpaceIfNeeded,
    ).toHaveBeenCalledWith('Hello world')
    expect(mockTextInserter.insertText).toHaveBeenCalledWith(' Hello world')
  })

  test('should not apply grammar rules when disabled', async () => {
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: false,
    })

    const mockTranscript = 'hello world'
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: { transcript: mockTranscript },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockGrammarRulesService.setCaseFirstWord).not.toHaveBeenCalled()
    expect(
      mockGrammarRulesService.addLeadingSpaceIfNeeded,
    ).not.toHaveBeenCalled()
    expect(mockTextInserter.insertText).toHaveBeenCalledWith(mockTranscript)
  })

  test('should handle transcription error from server', async () => {
    const errorMessage = 'ASR service unavailable'
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: {
        transcript: '',
        error: { message: errorMessage },
      } as any,
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockTextInserter.insertText).not.toHaveBeenCalled()
    expect(mockInteractionManager.createInteraction).toHaveBeenCalledWith(
      '',
      Buffer.from('audio-data'),
      16000,
      errorMessage,
    )
    expect(mockItoStreamController.endInteraction).toHaveBeenCalled()
    expect(mockInteractionManager.clearCurrentInteraction).toHaveBeenCalled()
  })

  test('should handle unexpected transcription error', async () => {
    const error = new Error('Network timeout')
    mockItoStreamController.startGrpcStream.mockRejectedValueOnce(error)

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockItoStreamController.endInteraction).toHaveBeenCalled()
    expect(mockInteractionManager.clearCurrentInteraction).toHaveBeenCalled()
  })

  test('should skip text insertion when no transcript', async () => {
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: { transcript: '' },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await session.completeSession()

    expect(mockTextInserter.insertText).not.toHaveBeenCalled()
  })

  test('should handle context fetch error gracefully', async () => {
    mockItoStreamController.scheduleConfigUpdate.mockRejectedValueOnce(
      new Error('Context fetch failed'),
    )

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    // Should not throw
    await session.startSession(ItoMode.TRANSCRIBE)

    // Wait for background context fetch to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    // Session should still continue normally
    expect(mockVoiceInputService.startAudioRecording).toHaveBeenCalled()
  })

  describe('Soniox mode', () => {
    beforeEach(() => {
      mockGetAdvancedSettings.mockReturnValue({
        grammarServiceEnabled: false,
        llm: {
          asrProvider: 'soniox',
          llmProvider: 'groq',
          llmModel: 'llama3',
          llmTemperature: 0.7,
        },
      })

      mockSonioxTempKeyManager.getKey.mockResolvedValue('test-key')
      mockSonioxPersistentSession.stopStreaming.mockResolvedValue({ text: 'raw soniox text', durationMs: 500, tokenCount: 10 })
      mockSonioxPersistentSession.getState.mockReturnValue('streaming')
      mockItoHttpClient.post.mockResolvedValue({
        success: true,
        transcript: 'adjusted text',
      })
    })

    test('should start recording immediately without waiting for Soniox connection', async () => {
      let resolveKey: (value: string) => void
      const keyPromise = new Promise<string>(resolve => {
        resolveKey = resolve
      })
      mockSonioxTempKeyManager.getKey.mockReturnValue(keyPromise)

      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      const startPromise = session.startSession(ItoMode.TRANSCRIBE)

      // Recording should start immediately, before key resolves
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(mockVoiceInputService.startAudioRecording).toHaveBeenCalled()
      expect(
        mockRecordingStateNotifier.notifyRecordingStarted,
      ).toHaveBeenCalledWith(ItoMode.TRANSCRIBE)

      // Audio handler should be registered for buffering
      expect(mockAudioRecorderService.on).toHaveBeenCalledWith(
        'audio-chunk',
        expect.any(Function),
      )

      // Now resolve the key
      resolveKey!('test-key')
      await startPromise
    })

    test('should complete session with direct text insertion in TRANSCRIBE mode', async () => {
      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      await session.startSession(ItoMode.TRANSCRIBE)
      await new Promise(resolve => setTimeout(resolve, 10))
      await session.completeSession()

      expect(mockTextInserter.insertText).toHaveBeenCalledWith('raw soniox text')
      expect(
        mockRecordingStateNotifier.notifyProcessingStarted,
      ).toHaveBeenCalled()
      expect(
        mockRecordingStateNotifier.notifyProcessingStopped,
      ).toHaveBeenCalled()
    })

    test('should complete session with LLM adjustment in EDIT mode', async () => {
      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      await session.startSession(ItoMode.EDIT)
      await new Promise(resolve => setTimeout(resolve, 10))
      await session.completeSession()

      expect(mockItoHttpClient.post).toHaveBeenCalledWith(
        '/adjust-transcript',
        expect.objectContaining({
          transcript: 'raw soniox text',
          mode: 'edit',
        }),
        { requireAuth: true },
      )
      expect(mockTextInserter.insertText).toHaveBeenCalledWith('adjusted text')
    })

    test('should fallback to raw transcript when LLM fails', async () => {
      mockItoHttpClient.post.mockResolvedValue({
        success: false,
        error: 'LLM error',
      })

      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      await session.startSession(ItoMode.TRANSCRIBE)
      await new Promise(resolve => setTimeout(resolve, 10))
      await session.completeSession()

      expect(mockTextInserter.insertText).toHaveBeenCalledWith(
        'raw soniox text',
      )
    })

    test('should handle cancel during Soniox connection', async () => {
      let resolveKey: (value: string) => void
      const keyPromise = new Promise<string>(resolve => {
        resolveKey = resolve
      })
      mockSonioxTempKeyManager.getKey.mockReturnValue(keyPromise)

      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      const startPromise = session.startSession(ItoMode.TRANSCRIBE)

      // Cancel before key resolves
      await session.cancelSession()

      expect(mockVoiceInputService.stopAudioRecording).toHaveBeenCalled()
      expect(
        mockRecordingStateNotifier.notifyRecordingStopped,
      ).toHaveBeenCalled()

      // Resolve key — persistent session will connect but cancel already ran
      resolveKey!('test-key')
      await startPromise
    })

    test('should not register streaming text listener during recording', async () => {
      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      await session.startSession(ItoMode.TRANSCRIBE)
      await new Promise(resolve => setTimeout(resolve, 10))
      await session.completeSession()

      expect(mockSonioxPersistentSession.on).not.toHaveBeenCalledWith(
        'final-text',
        expect.any(Function),
      )
    })

    test('should handle Soniox connection failure gracefully', async () => {
      mockSonioxTempKeyManager.getKey.mockRejectedValue(
        new Error('key fetch failed'),
      )
      mockSonioxPersistentSession.getState.mockReturnValue('idle')

      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      await session.startSession(ItoMode.TRANSCRIBE)
      await new Promise(resolve => setTimeout(resolve, 10))
      await session.completeSession()

      // No speech detected path — sonioxService is null so rawTranscript is ''
      expect(mockTextInserter.insertText).not.toHaveBeenCalled()
      expect(
        mockRecordingStateNotifier.notifyRecordingStopped,
      ).toHaveBeenCalled()
    })

    test('should cap pending buffer and not grow unbounded', async () => {
      let resolveKey: (value: string) => void
      const keyPromise = new Promise<string>(resolve => {
        resolveKey = resolve
      })
      mockSonioxTempKeyManager.getKey.mockReturnValue(keyPromise)

      const { ItoSessionManager } = await import('./itoSessionManager')
      const session = new ItoSessionManager()

      const startPromise = session.startSession(ItoMode.TRANSCRIBE)
      await new Promise(resolve => setTimeout(resolve, 10))

      // Grab the audio handler that was registered
      const audioHandler = mockAudioRecorderService.on.mock.calls.find(
        (c: any[]) => c[0] === 'audio-chunk',
      )?.[1] as (chunk: Buffer) => void
      expect(audioHandler).toBeDefined()

      // Send a massive chunk that exceeds the cap (512KB)
      const hugeChunk = Buffer.alloc(600 * 1024)
      audioHandler(hugeChunk)

      // Further chunks should be silently dropped
      const extraChunk = Buffer.alloc(1024)
      audioHandler(extraChunk)

      // Resolve so the session completes
      resolveKey!('test-key')
      await startPromise

      // The service should have received the first chunk (under cap) but not the second
      expect(mockSonioxPersistentSession.sendAudio).toHaveBeenCalledTimes(1)
      expect(mockSonioxPersistentSession.sendAudio).toHaveBeenCalledWith(
        hugeChunk,
      )

      await session.cancelSession()
    })
  })

  test('should handle complete session flow', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    const mockTranscript = 'Test complete flow'
    mockItoStreamController.startGrpcStream.mockResolvedValueOnce({
      response: { transcript: mockTranscript },
      audioBuffer: Buffer.from('audio-data'),
      sampleRate: 16000,
    })

    // Start session
    await session.startSession(ItoMode.TRANSCRIBE)

    expect(mockItoStreamController.initialize).toHaveBeenCalled()
    expect(mockVoiceInputService.startAudioRecording).toHaveBeenCalled()

    // Complete session
    await session.completeSession()

    expect(mockVoiceInputService.stopAudioRecording).toHaveBeenCalled()
    expect(mockItoStreamController.endInteraction).toHaveBeenCalled()
    expect(mockTextInserter.insertText).toHaveBeenCalledWith(mockTranscript)
    expect(mockRecordingStateNotifier.notifyRecordingStopped).toHaveBeenCalled()
  })

  test('should guard setMode against Soniox mode', async () => {
    mockGetAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: false,
      llm: {
        asrProvider: 'soniox',
        llmProvider: 'groq',
        llmModel: 'llama3',
        llmTemperature: 0.7,
      },
    })

    const { ItoSessionManager } = await import('./itoSessionManager')
    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await new Promise(resolve => setTimeout(resolve, 10))

    mockItoStreamController.setMode.mockClear()
    session.setMode(ItoMode.EDIT)

    // In Soniox mode, itoStreamController.setMode should NOT be called
    expect(mockItoStreamController.setMode).not.toHaveBeenCalled()
    expect(
      mockRecordingStateNotifier.notifyRecordingStarted,
    ).toHaveBeenCalledWith(ItoMode.EDIT)

    await session.cancelSession()
  })
})
