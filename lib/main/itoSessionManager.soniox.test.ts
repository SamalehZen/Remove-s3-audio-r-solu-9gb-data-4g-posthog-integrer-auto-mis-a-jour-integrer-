import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { ItoMode } from '@/app/generated/ito_pb'

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
  setCustomMode: mock(),
}
mock.module('./recordingStateNotifier', () => ({
  recordingStateNotifier: mockRecordingStateNotifier,
}))

const mockInteractionManager = {
  getCurrentInteractionId: mock((): string | null => null),
  adoptInteractionId: mock(),
  initialize: mock(() => 'interaction-1'),
  createInteraction: mock(() => Promise.resolve()),
  clearCurrentInteraction: mock(),
}
mock.module('./interactions/InteractionManager', () => ({
  interactionManager: mockInteractionManager,
}))

const mockContextGrabber = {
  gatherContext: mock(() =>
    Promise.resolve({
      vocabularyWords: [],
      replacements: [],
      tone: null,
      userDetails: null,
      screenCaptureBase64: null,
      screenCaptureMimeType: null,
      screenThumbnailBase64: null,
      contextSource: null,
      windowTitle: '',
      appName: '',
      contextText: '',
      browserUrl: null,
      browserDomain: null,
    }),
  ),
  getCursorContextForGrammar: mock(() => Promise.resolve('')),
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

const mockStoreModule = {
  getAdvancedSettings: mock(() => ({
    grammarServiceEnabled: false,
    llm: {
      asrProvider: 'soniox',
      sonioxFastLlmEnabled: false,
    },
  })),
  getCurrentUserId: mock(() => 'user-1'),
  store: {
    get: mock(() => ({ muteAudioWhenDictating: false })),
  },
}
mock.module('./store', () => ({
  ...mockStoreModule,
  default: mockStoreModule.store,
}))

mock.module('electron-log', () => ({
  default: {
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}))

const mockSonioxTempKeyManager = {
  getKey: mock(() => Promise.resolve('temp-key')),
  warmup: mock(() => Promise.resolve()),
  invalidate: mock(),
}
mock.module('./soniox/SonioxTempKeyManager', () => ({
  sonioxTempKeyManager: mockSonioxTempKeyManager,
}))

const createdSonioxServices: any[] = []
class MockSonioxStreamingService {
  start = mock(async () => {})
  stop = mock(async () => 'raw soniox text')
  cancel = mock(() => {})
  sendAudio = mock(() => {})
  on = mock((_event: string, _handler: any) => this)
  isCurrentlyActive = mock(() => true)
  hasEncounteredError = mock(() => false)

  constructor() {
    createdSonioxServices.push(this)
  }
}
mock.module('./soniox/SonioxStreamingService', () => ({
  SonioxStreamingService: MockSonioxStreamingService,
}))

const mockAudioRecorderService = {
  on: mock(),
  off: mock(),
  stopRecording: mock(),
  awaitDrainComplete: mock(() => Promise.resolve()),
}
mock.module('../media/audio', () => ({
  audioRecorderService: mockAudioRecorderService,
}))

const mockTextInserter = {
  insertText: mock(() => Promise.resolve(true)),
}
mock.module('./text/TextInserter', () => ({
  TextInserter: class MockTextInserter {
    insertText = mockTextInserter.insertText
  },
}))

const mockTimingCollector = {
  startInteraction: mock(),
  startTiming: mock(),
  endTiming: mock(),
  finalizeInteraction: mock(),
  clearInteraction: mock(),
  timeAsync: mock(async (_event: any, fn: any) => await fn()),
}
mock.module('./timing/TimingCollector', () => ({
  timingCollector: mockTimingCollector,
  TimingEventName: {
    INTERACTION_ACTIVE: 'INTERACTION_ACTIVE',
    GRAMMAR_SERVICE: 'GRAMMAR_SERVICE',
  },
}))

const mockItoHttpClient = {
  post: mock(() =>
    Promise.resolve({ success: true, transcript: 'adjusted text' }),
  ),
}
mock.module('../clients/itoHttpClient', () => ({
  itoHttpClient: mockItoHttpClient,
}))

mock.module('../constants/generated-defaults', () => ({
  DEFAULT_ADVANCED_SETTINGS: {
    sonioxFastLlmProvider: 'cerebras',
    sonioxFastLlmModel: 'llama-3.3-70b',
    sonioxFastPrompt: 'fast prompt',
  },
}))

mock.module('./context/CustomModeResolver', () => ({
  customModeResolver: {
    resolve: mock(() => Promise.resolve(null)),
  },
}))

mock.module('./ActiveWindowMonitor', () => ({
  activeWindowMonitor: {
    getCachedState: mock(() => null),
  },
}))

mock.module('./context/DomainContextProvider', () => ({
  domainContextProvider: {
    buildSonioxContext: mock(() => Promise.resolve(null)),
  },
}))

mock.module('./sqlite/userDetailsRepo', () => ({
  UserDetailsTable: {
    findByUserId: mock(() => Promise.resolve(null)),
  },
}))

mock.module('./sqlite/repo', () => ({
  InteractionsTable: {
    upsert: mock(() => Promise.resolve()),
    findModifiedSince: mock(() => Promise.resolve([])),
    softDelete: mock(() => Promise.resolve()),
  },
  NotesTable: {
    findModifiedSince: mock(() => Promise.resolve([])),
    softDelete: mock(() => Promise.resolve()),
    upsert: mock(() => Promise.resolve()),
  },
  DictionaryTable: {
    findAll: mock(() => Promise.resolve([])),
    findModifiedSince: mock(() => Promise.resolve([])),
    softDelete: mock(() => Promise.resolve()),
    upsert: mock(() => Promise.resolve()),
  },
  KeyValueStore: {
    get: mock(() => Promise.resolve(undefined)),
    set: mock(() => Promise.resolve()),
    delete: mock(() => Promise.resolve()),
  },
}))

const mockSystemAudio = {
  unmuteSystemAudio: mock(),
}
mock.module('../media/systemAudio', () => mockSystemAudio)

mock.module('./appNap', () => ({
  preventAppNap: mock(),
  allowAppNap: mock(),
}))

describe('ItoSessionManager Soniox low-latency fixes', () => {
  beforeEach(() => {
    createdSonioxServices.length = 0
    Object.values(mockVoiceInputService).forEach(mockFn => mockFn.mockClear())
    Object.values(mockRecordingStateNotifier).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockInteractionManager).forEach(mockFn => mockFn.mockClear())
    Object.values(mockContextGrabber).forEach(mockFn => mockFn.mockClear())
    Object.values(mockGrammarRulesService).forEach(mockFn => mockFn.mockClear())
    Object.values(mockSonioxTempKeyManager).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockAudioRecorderService).forEach(mockFn =>
      mockFn.mockClear(),
    )
    Object.values(mockTextInserter).forEach(mockFn => mockFn.mockClear())
    Object.values(mockTimingCollector).forEach(mockFn => mockFn.mockClear())
    mockStoreModule.getAdvancedSettings.mockReset()
    mockStoreModule.getAdvancedSettings.mockReturnValue({
      grammarServiceEnabled: false,
      llm: {
        asrProvider: 'soniox',
        sonioxFastLlmEnabled: false,
      },
    })
    mockStoreModule.getCurrentUserId.mockReset()
    mockStoreModule.getCurrentUserId.mockReturnValue('user-1')
    mockStoreModule.store.get.mockReset()
    mockStoreModule.store.get.mockReturnValue({ muteAudioWhenDictating: false })
    mockAudioRecorderService.awaitDrainComplete.mockResolvedValue(undefined)
  })

  test('uses bounded drain for Soniox transcribe fast path', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')

    const session = new ItoSessionManager()

    await session.startSession(ItoMode.TRANSCRIBE)
    await new Promise(resolve => setTimeout(resolve, 0))
    await session.completeSession()

    expect(mockAudioRecorderService.stopRecording).toHaveBeenCalledTimes(1)
    expect(mockAudioRecorderService.awaitDrainComplete).toHaveBeenCalledWith(
      120,
    )
    expect(mockVoiceInputService.stopAudioRecording).not.toHaveBeenCalled()
    expect(createdSonioxServices[0].stop).toHaveBeenCalledTimes(1)
    expect(mockTextInserter.insertText).toHaveBeenCalledWith('raw soniox text')
  })

  test('discards stale pre-warmed connection before creating a new one', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')

    const session = new ItoSessionManager() as any
    const stalePreWarmed = new MockSonioxStreamingService()
    stalePreWarmed.isCurrentlyActive.mockReturnValue(false)

    session.preWarmedSonioxService = stalePreWarmed
    session.preWarmTimestamp = Date.now()

    await session.startSession(ItoMode.TRANSCRIBE)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(stalePreWarmed.cancel).toHaveBeenCalledTimes(1)
    expect(createdSonioxServices.length).toBeGreaterThanOrEqual(2)
    expect(createdSonioxServices[1].start).toHaveBeenCalledTimes(1)
  })

  test('expires unused pre-warmed connection after TTL', async () => {
    const { ItoSessionManager } = await import('./itoSessionManager')

    const session = new ItoSessionManager() as any
    session.PRE_WARM_TTL_MS = 5

    session.preWarmSonioxConnection()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(createdSonioxServices[0].start).toHaveBeenCalledTimes(1)

    await new Promise(resolve => setTimeout(resolve, 15))

    expect(createdSonioxServices[0].cancel).toHaveBeenCalledTimes(1)
    expect(session.preWarmedSonioxService).toBeNull()
  })
})
