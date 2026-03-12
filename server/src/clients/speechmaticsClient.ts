import { createSpeechmaticsJWT } from '@speechmatics/auth'
import * as dotenv from 'dotenv'
import { ClientProvider } from './providers.js'

dotenv.config()

class SpeechmaticsClientWrapper {
  private readonly _apiKey: string
  private readonly _isValid: boolean

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(`${ClientProvider.SPEECHMATICS} API key not provided`)
    }
    this._apiKey = apiKey
    this._isValid = true
  }

  public get isAvailable(): boolean {
    return this._isValid
  }

  public async createTemporaryJWT(ttl: number = 60): Promise<string> {
    return createSpeechmaticsJWT({
      type: 'rt',
      apiKey: this._apiKey,
      ttl,
      region: 'eu',
    })
  }
}

const apiKey = process.env.SPEECHMATICS_API_KEY

let speechmaticsClient: SpeechmaticsClientWrapper | null = null

if (apiKey) {
  try {
    speechmaticsClient = new SpeechmaticsClientWrapper(apiKey)
    console.log('Speechmatics client initialized successfully')
  } catch (error) {
    console.error('Failed to initialize Speechmatics client:', error)
    speechmaticsClient = null
  }
} else {
  console.log('SPEECHMATICS_API_KEY not set - Speechmatics client will not be available')
}

export { speechmaticsClient }
