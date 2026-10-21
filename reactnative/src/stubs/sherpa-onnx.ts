/**
 * Stub for the desktop `sherpa-onnx-node` package.
 *
 * The desktop build runs the Sherpa-ONNX speech synthesis engine as a native
 * addon inside a forked worker process. React Native cannot load a Node native
 * addon, and the worker itself is started through `child_process.fork()` -
 * which is inert on mobile as well.
 *
 * The stub keeps the API surface so that `modules/tts/worker.js` can be
 * bundled unchanged, but every call fails with an explanatory error. The TTS
 * module of the desktop application falls back to the other engines (chestnut
 * / glm-tts), so the feature degrades instead of breaking.
 */
export interface TtsConfig {
  model?: any;
  tokens?: any;
  numThreads?: number;
  provider?: string;
  [key: string]: any;
}

export interface TtsAudio {
  audio: Float32Array;
  sampleRate: number;
}

export class OfflineTts {
  readonly config: TtsConfig;

  constructor(config: TtsConfig = {}) {
    this.config = config;
  }

  generate(_text?: any, _sid?: number): TtsAudio {
    throw new Error(
      '[E2RN] sherpa-onnx 原生语音合成在移动端不可用，请改用其他语音引擎。',
    );
  }

  release(): void {
    // No-op.
  }
}

export class OnlineTts {
  readonly config: TtsConfig;

  constructor(config: TtsConfig = {}) {
    this.config = config;
  }

  generate(_text?: any): TtsAudio {
    throw new Error(
      '[E2RN] sherpa-onnx 在线语音合成在移动端不可用，请改用其他语音引擎。',
    );
  }

  release(): void {
    // No-op.
  }
}

export default {OfflineTts, OnlineTts};
