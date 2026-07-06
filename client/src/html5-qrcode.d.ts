// Type stub for html5-qrcode (no official @types package).
// The library exposes `Html5Qrcode` plus a static `getCameras` helper.
// We only need `start/stop/clear` for live-scanning; for the rest we
// type-narrow at the call site.
declare module 'html5-qrcode' {
  export interface Html5QrcodeCameraScanConfig {
    fps?: number;
    qrbox?: { width: number; height: number } | number;
    aspectRatio?: number;
    disableFlip?: boolean;
    videoConstraints?: MediaTrackConstraints;
  }

  export type Html5QrcodeSuccessCallback = (
    decodedText: string,
    result: { resultText: string }
  ) => void;
  export type Html5QrcodeErrorCallback = (errorMessage: string) => void;

  export class Html5Qrcode {
    constructor(elementId: string);
    start(
      cameraConfig: MediaTrackConstraints | Html5QrcodeCameraScanConfig,
      config: Html5QrcodeCameraScanConfig,
      successCallback: Html5QrcodeSuccessCallback,
      errorCallback?: Html5QrcodeErrorCallback
    ): Promise<void>;
    stop(): Promise<void>;
    clear(): void;
    static getCameras(): Promise<{ id: string; label: string }[]>;
  }
}
