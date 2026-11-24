import { Matrix4, Vector2, Vector3 } from "three";
import qimPathTrace from "./shaders/qimPathTrace.frag";
export const qimPathTraceFragmentShaderSrc = qimPathTrace;

export const qimPathTraceUniforms = () => ({
  // sampling
  previous: { type: "t", value: null as any },
  sampleWeight: { type: "f", value: 0.0 },

  // volume
  volume: { type: "t", value: null as any },
  volumeMin: { type: "v3", value: new Vector3(-0.5) },
  volumeMax: { type: "v3", value: new Vector3(0.5) },
  volumeInvSize: { type: "v3", value: new Vector3(1.0) },

  // camera
  invResolution: { type: "v2", value: new Vector2(0.0, 0.0) },
  invViewProjection: { type: "m4", value: new Matrix4() },
});
