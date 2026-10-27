// テスト用の合成の音。実在の曲の音は使わない。

/** 16 kHz・モノラルの Int16。Hann 形の包絡の 60 ms の音（tone burst）を 0.5 秒ごとに鳴らす。 */
export function toneBursts(freqHz: number, seconds = 12, amplitude = 8000): Int16Array {
  const rate = 16000;
  const out = new Int16Array(seconds * rate);
  const burst = Math.round(0.06 * rate);
  const period = Math.round(0.5 * rate);
  for (let start = 0; start + burst <= out.length; start += period) {
    for (let i = 0; i < burst; i++) {
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (burst - 1));
      out[start + i] = Math.round(amplitude * env * Math.sin((2 * Math.PI * freqHz * (start + i)) / rate));
    }
  }
  return out;
}

/** 44.1 kHz・ステレオ・16 bit の WAV（正弦波）。 */
export function wavBytes(seconds: number, hz = 440, rate = 44100): Uint8Array {
  const frames = seconds * rate;
  const out = new Uint8Array(44 + frames * 4);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / rate));
    v.setInt16(44 + i * 4, s, true);
    v.setInt16(46 + i * 4, s, true);
  }
  return out;
}
