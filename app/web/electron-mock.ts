const noop = () => {}
const noopAsync = async () => {}
const noopCleanup = () => noop

const mockStoreData: Record<string, any> = {
  auth: {
    user: {
      id: 'web-preview',
      email: 'preview@ito.app',
      name: 'Preview User',
      provider: 'self-hosted',
    },
    tokens: null,
    isSelfHosted: true,
  },
  main: {
    navExpanded: true,
    currentPage: 'home',
    settingsPage: 'general',
  },
  onboarding: {
    onboardingStep: 10,
    onboardingCompleted: true,
  },
  settings: {
    shareAnalytics: false,
    launchAtLogin: false,
    showItoBarAlways: true,
    showAppInDock: true,
    interactionSounds: false,
    muteAudioWhenDictating: false,
    microphoneDeviceId: 'default',
    microphoneName: 'Default Microphone',
    keyboardShortcuts: [
      { id: 'web-shortcut-transcribe', keys: ['fn'], mode: 0 },
      { id: 'web-shortcut-edit', keys: ['control-left', 'fn'], mode: 1 },
      { id: 'web-shortcut-context', keys: ['option-left', 'fn'], mode: 3 },
      { id: 'web-shortcut-agent', keys: [], mode: 0, isAgent: true },
    ],
    translationTargetLanguage: 'en',
    translationType: 'one_way',
    translationLanguageA: 'fr',
    translationLanguageB: 'en',
    contextAwarenessCaptureMode: 'fullscreen',
  },
  performance: {
    userSelectedTier: 'high',
    detectedTier: 'high',
    activeTier: 'high',
  },
  advancedSettings: {
    grammarServiceEnabled: false,
    macosAccessibilityContextEnabled: false,
  },
}

const invokeHandlers: Record<string, (...args: any[]) => any> = {
  'init-window': () => ({
    width: 1270,
    height: 800,
    minimizable: true,
    maximizable: true,
    platform: 'darwin',
  }),
  'check-accessibility-permission': () => true,
  'check-microphone-permission': () => true,
  'get-native-audio-devices': () => ['Built-in Microphone'],
  'get-platform': () => 'darwin',
  'analytics:get-device-id': () => 'web-preview-device',
  'analytics:resolve-install-token': () => ({ success: false }),
  'start-key-listener-service': () => true,
  'stop-key-listener-service': () => true,
  'refresh-tokens': () => ({ success: true }),
}

const mockUpdater = {
  onUpdateAvailable: noopCleanup,
  onUpdateNotAvailable: noopCleanup,
  onUpdateDownloaded: noopCleanup,
  onUpdateError: noopCleanup,
  onDownloadProgress: noopCleanup,
  installUpdate: noop,
  downloadUpdate: async () => ({ success: false }),
  getUpdateStatus: async () => ({
    updateAvailable: false,
    updateDownloaded: false,
  }),
  checkForUpdates: async () => ({ success: false }),
}

;(window as any).electron = {
  ipcRenderer: {
    invoke: noopAsync,
    send: noop,
    on: noopCleanup,
    removeAllListeners: noop,
  },
  process: {
    platform: 'darwin',
    versions: { electron: '0.0.0', node: '0.0.0', chrome: '0.0.0' },
  },
  store: {
    get: (key: string) => mockStoreData[key] ?? null,
    set: noop,
  },
}
;(window as any).api = {
  invoke: async (channel: string, ...args: any[]) => {
    const handler = invokeHandlers[channel]
    if (handler) return handler(...args)
    return undefined
  },
  on: (_channel: string, _listener: (...args: any[]) => void) => noop,
  send: noop,
  updater: mockUpdater,
  generateNewAuthState: noopAsync,
  getNativeAudioDevices: async () => ['Built-in Microphone'],
  notifyLoginSuccess: noopAsync,
  notifySettingsUpdate: noop,
  notifyOnboardingUpdate: noop,
  notifyUserAuthUpdate: noop,
  logout: noopAsync,
  deleteUserData: noopAsync,
  getPlatform: async () => 'darwin',
  registerHotkeys: noop,
  notes: {
    getAll: async () => [],
    add: async (note: any) => ({ id: crypto.randomUUID(), ...note }),
    updateContent: noopAsync,
    delete: noopAsync,
  },
  dictionary: {
    getAll: async () => [],
    add: async (item: any) => ({ id: crypto.randomUUID(), ...item }),
    update: noopAsync,
    delete: noopAsync,
  },
  userDetails: {
    get: async () => ({ details: null, additionalInfo: [] }),
    save: async () => ({ success: true }),
  },
  interactions: {
    getAll: async () => [],
    getById: async () => null,
    delete: noopAsync,
  },
  loginItem: {
    setSettings: noopAsync,
    getSettings: async () => ({ openAtLogin: false, openAsHidden: false }),
  },
  dock: {
    setVisibility: noopAsync,
    getVisibility: async () => ({ isVisible: true }),
  },
  billing: {
    createCheckoutSession: async () => ({ success: false, error: 'Web preview' }),
    confirmSession: async () => ({ success: false, error: 'Web preview' }),
    status: async () => ({
      success: true,
      pro_status: 'active_pro' as const,
      trial: {
        trialDays: 14,
        trialStartAt: null,
        daysLeft: 14,
        isTrialActive: false,
        hasCompletedTrial: false,
      },
    }),
  },
  trial: {
    start: async () => ({
      success: true,
      trialDays: 14,
      trialStartAt: null,
      daysLeft: 14,
      isTrialActive: false,
      hasCompletedTrial: false,
    }),
    complete: async () => ({
      success: true,
      trialDays: 14,
      trialStartAt: null,
      daysLeft: 0,
      isTrialActive: false,
      hasCompletedTrial: true,
    }),
  },
  selectedText: {
    get: async () => ({ success: false, text: null, error: null, length: 0 }),
    getString: async () => null,
    hasSelected: async () => false,
  },
  logs: {
    download: async () => ({ success: false, error: 'Web preview' }),
    clear: async () => ({ success: true }),
  },
  appTargets: {
    getAll: async () => [],
    create: async (t: any) => ({ id: crypto.randomUUID(), ...t }),
    update: noopAsync,
    delete: noopAsync,
    detectCurrentApp: async () => null,
  },
  tones: {
    getAll: async () => [],
    create: async (t: any) => ({ id: crypto.randomUUID(), ...t }),
    update: noopAsync,
    delete: noopAsync,
  },
  setPillMouseEvents: noopAsync,
  exchangeAuthCode: noopAsync,
  startKeyListener: async () => true,
  stopKeyListener: async () => true,
  startNativeRecording: noopAsync,
  stopNativeRecording: noopAsync,
  blockKeys: noopAsync,
  unblockKey: noopAsync,
  getBlockedKeys: noopAsync,
  onKeyEvent: noop,
}
