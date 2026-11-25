import { Matrix4, Vector2, Vector3 } from "three";
import qimPathTrace from "./shaders/qimPathTrace.frag";
export const qimPathTraceFragmentShaderSrc = qimPathTrace;

export const qimPathTraceUniforms = () => ({
  // sampling
  previous: { type: "t", value: null as any },
  sampleSeed: { type: "u", value: 0 },
  sampleWeight: { type: "f", value: 1.0 },

  // volume
  volume: { type: "t", value: null as any },
  volumeMin: { type: "v3", value: new Vector3(-0.5) },
  volumeMax: { type: "v3", value: new Vector3(0.5) },
  volumeInvSize: { type: "v3", value: new Vector3(1.0) },
  volumeMajorant: { type: "f", value: 1.0 },

  // camera
  resolution: { type: "uv2", value: new Uint32Array([1, 1]) },
  invResolution: { type: "v2", value: new Vector2(1.0, 1.0) },
  invViewProjection: { type: "m4", value: new Matrix4() },
});
