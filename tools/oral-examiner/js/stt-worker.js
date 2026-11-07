// Speech recognition with OpenAI Whisper (MIT) via transformers.js (Apache 2.0),
// running entirely in the student's browser. Audio never leaves the device;
// only the transcribed text is sent to the examiner.
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

const MODEL = "onnx-community/whisper-base.en";
let asr = null;

async function load(device) {
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) self.postMessage({ type: "progress", file: p.file, ratio: p.loaded / p.total });
  };
  if (device === "webgpu") {
    return pipeline("automatic-speech-recognition", MODEL, {
      device: "webgpu",
      dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
      progress_callback,
    });
  }
  return pipeline("automatic-speech-recognition", MODEL, { device: "wasm", dtype: "q8", progress_callback });
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  try {
    if (type === "load") {
      if (!asr) {
        try {
          asr = await load(e.data.webgpu ? "webgpu" : "wasm");
        } catch (err) {
          if (!e.data.webgpu) throw err;
          asr = await load("wasm");
        }
      }
      self.postMessage({ type: "ready", id });
    } else if (type === "transcribe") {
      const out = await asr(e.data.audio, { language: undefined, chunk_length_s: 30, stride_length_s: 5 });
      self.postMessage({ type: "result", id, text: (out.text || "").trim() });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, error: String(err?.message || err) });
  }
};
