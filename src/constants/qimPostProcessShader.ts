import { Vector3 } from "three";
import qimPostProcess from "./shaders/qimPostProcess.frag";
export const qimPostProcessFragmentShaderSrc = qimPostProcess;

export const qimPostProcessUniforms = () => ({
  tHdr: {
    type: "t",
    value: null as any,
  },
});
