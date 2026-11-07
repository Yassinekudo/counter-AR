// Camera access tuned for smooth 60 fps preview.
export async function openCamera({ resolution = 720, fps = 60 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext
      ? 'This browser cannot access the camera.'
      : 'Camera needs a secure (https://) connection. Open the app over HTTPS.');
  }
  const long = resolution === 1080 ? 1920 : 1280;
  const short = resolution === 1080 ? 1080 : 720;
  const attempts = [
    { facingMode: { ideal: 'environment' }, width: { ideal: long }, height: { ideal: short }, frameRate: { ideal: fps } },
    { facingMode: { ideal: 'environment' }, frameRate: { ideal: fps } },
    true,
  ];
  let stream, lastErr;
  for (const video of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }); break; }
    catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
    }
  }
  if (!stream) throw lastErr;
  const track = stream.getVideoTracks()[0];
  // Ask for the highest frame rate the sensor offers at this size, and continuous focus.
  try {
    const caps = track.getCapabilities?.() || {};
    const adv = {};
    if (caps.frameRate?.max) adv.frameRate = Math.min(fps, caps.frameRate.max);
    if (caps.focusMode?.includes?.('continuous')) adv.focusMode = 'continuous';
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
  } catch { /* optional */ }
  return stream;
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function streamInfo(stream) {
  const s = stream?.getVideoTracks()[0]?.getSettings?.() || {};
  return { width: s.width, height: s.height, frameRate: s.frameRate };
}
