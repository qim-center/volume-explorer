import { Matrix4, Vector2, Vector3 } from "three";
import qimPathTrace from "./shaders/qimPathTrace.frag";
export const qimPathTraceFragmentShaderSrc = qimPathTrace;

export const qimPathTraceUniforms = () => ({
  // Sampling
  previous: { type: "t", value: null as any },
  sampleSeed: { type: "u", value: 0 },
  sampleWeight: { type: "f", value: 1.0 },

  // Volume
  volume: { type: "t", value: null as any },
  volumeMin: { type: "v3", value: new Vector3(-0.5) },
  volumeMax: { type: "v3", value: new Vector3(0.5) },
  volumeInvSize: { type: "v3", value: new Vector3(1.0) },
  majorant: { type: "f", value: 1.0 },
  
  // Lut
  intensityMin: { type: "f", value: 0.0 },
  intensityInvRange: { type: "f", value: 1.0 },
  lut: { type: "t", value: null as any },
  alphaToExtinctionFactor: { type: "f", value: 1.0 },

  // Camera
  resolution: { type: "uv2", value: new Uint32Array([1, 1]) },
  invResolution: { type: "v2", value: new Vector2(1.0, 1.0) },
  invViewProjection: { type: "m4", value: new Matrix4() },
});
