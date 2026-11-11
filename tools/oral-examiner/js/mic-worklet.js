// Audio worklet that forwards microphone samples to the page in short frames.
// The audio itself never leaves the device: frames are used for voice-activity
// detection and on-device transcription only.
class MicFrames extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.frameSize || 1408;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.size - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.size) {
          const out = this.buf;
          this.port.postMessage(out, [out.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-frames", MicFrames);
