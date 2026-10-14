/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { SpeechRecognitionConstructor } from './src/domain/speech-recognition'

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export {}
