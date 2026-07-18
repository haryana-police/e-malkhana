import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  title?: string;
  /** Called with the captured JPEG data URL and a File object. */
  onCapture: (dataUrl: string, file: File) => void;
  onClose: () => void;
}

// Live in-app camera using getUserMedia. Works on BOTH desktop (webcam) and
// mobile (rear camera via facingMode: environment). This is the only reliable
// way to open a real camera on desktop Chrome — the HTML `capture` attribute is
// ignored by desktop browsers and just opens the file picker.
export function CameraCaptureModal({ open, title = 'Capture Photo', onCapture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      setErr('Camera API not supported in this browser.');
      return;
    }
    md.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
      })
      .catch(e => { if (!cancelled) setErr(e?.message || 'Camera not available'); });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || busy) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setErr('Could not read the camera frame.'); return; }
    ctx.drawImage(video, 0, 0, w, h);
    setBusy(true);
    canvas.toBlob(blob => {
      setBusy(false);
      if (!blob) { setErr('Capture failed — please try again.'); return; }
      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
      const reader = new FileReader();
      reader.onload = () => { onCapture(String(reader.result || ''), file); onClose(); };
      reader.onerror = () => setErr('Capture failed — please try again.');
      reader.readAsDataURL(file);
    }, 'image/jpeg', 0.92);
  }

  if (!open) return null;
  return (
    <div className="overlay cam-overlay open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cam-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cam-head">
          <h3>{title}</h3>
          <button type="button" className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err ? (
          <div className="cam-error">
            <p>📷 Camera unavailable: {err}</p>
            <p className="cam-hint">Allow camera permission in the browser, or use “Choose file” to attach a photo from gallery / files.</p>
          </div>
        ) : (
          <video ref={videoRef} className="cam-video" playsInline muted />
        )}
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <div className="cam-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {!err && (
            <button type="button" className="btn" onClick={capture} disabled={busy}>
              {busy ? 'Capturing…' : '📷 Capture'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
