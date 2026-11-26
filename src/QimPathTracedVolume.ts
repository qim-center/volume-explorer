import {
  DataTexture,
  Data3DTexture,
  FloatType,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  WebGLRenderer,
  RedFormat,
  Vector2,
  NoBlending,
} from "three";

import { renderToBufferVertShader, copyImageFragShader } from "./constants/basicShaders.js";
import { denoiseFragmentShaderSrc, denoiseShaderUniforms } from "./constants/denoiseShader.js";
import { pathtraceOutputFragmentShaderSrc, pathtraceOutputShaderUniforms } from "./constants/pathtraceOutputShader.js";
import { pathTracingFragmentShaderSrc, pathTracingUniforms } from "./constants/volumePTshader.js";

import { LUT_ENTRIES, LUT_ARRAY_LENGTH } from "./Lut.js";
import Volume from "./Volume.js";
import { FUSE_DISABLED_RGB_COLOR, type FuseChannel, isOrthographicCamera } from "./types.js";
import { Light } from "./Light.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";
import { VolumeRenderSettings, SettingsFlags } from "./VolumeRenderSettings.js";
import Channel from "./Channel.js";
import RenderToBuffer from "./RenderToBuffer.js";
import { qimPathTraceUniforms, qimPathTraceFragmentShaderSrc } from "./constants/qimPathTraceShader.js";
import { qimPostProcessFragmentShaderSrc, qimPostProcessUniforms } from "./constants/qimPostProcessShader.js";

export default class QimPathTracedVolume implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;

  private volume: Volume;

  private volumeTexture: Data3DTexture;
  private lutTexture: DataTexture;

  // Resources related to sampling
  private uniforms = qimPathTraceUniforms();
  private renderToBuffer: RenderToBuffer;
  // Two render targets to do ping-pong with
  private renderTargets: WebGLRenderTarget[] = [];

  // Resources related to post processing
  private postProcessUniforms = qimPostProcessUniforms();
  private postProcessRenderToBuffer: RenderToBuffer;

  // Internal state needed by shaders
  private isCameraMoving: boolean = false;
  private sampleCount: number = 0;
  private alphaToExtinctionFactor = 100.0;

  private renderUpdateListener?: (iteration: number) => void;

  /**
   * Creates a new QimPathTracedVolume.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;

    // setup uniforms that won't change per frame
    
    const { x: sx, y: sy, z: sz } = volume.imageInfo.subregionSize;
    const data = new Float32Array(sx * sy * sz).fill(0.0);
    
    this.volumeTexture = new Data3DTexture(data, sx, sy, sz);
    this.volumeTexture.format = RedFormat;
    this.volumeTexture.type = FloatType; // TODO: possibly reduce precision to save bandwidth?
    this.volumeTexture.minFilter = NearestFilter;
    this.volumeTexture.magFilter = NearestFilter;
    this.volumeTexture.generateMipmaps = false;
    this.volumeTexture.needsUpdate = true;

    this.uniforms.volume.value = this.volumeTexture;

    // create lut texture
    const lutData = new Uint8Array(LUT_ARRAY_LENGTH).fill(1);
    
    this.lutTexture = new DataTexture(lutData, LUT_ENTRIES, 1)
    this.lutTexture.format = RGBAFormat;
    this.lutTexture.type = UnsignedByteType;
    this.lutTexture.minFilter = LinearFilter;
    this.lutTexture.magFilter = LinearFilter;
    this.lutTexture.generateMipmaps = false;
    this.lutTexture.needsUpdate = true;

    this.uniforms.lut.value = this.lutTexture;

    // Initialize ping pong render targets
    for (let i = 0; i < 2; i++) {
      this.renderTargets.push(new WebGLRenderTarget(2, 2, {
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        format: RGBAFormat,
        type: FloatType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      }));
    } 
    this.renderToBuffer = new RenderToBuffer(qimPathTraceFragmentShaderSrc, this.uniforms);
    this.renderToBuffer.material.blending = NoBlending; // no effect when transparent = false, but just to be clear

    this.postProcessRenderToBuffer= new RenderToBuffer(qimPostProcessFragmentShaderSrc, this.postProcessUniforms);
    this.postProcessRenderToBuffer.material.transparent = true;

    // Update settings
    this.updateSettings(settings);
    this.settings = settings; // turns off ts initialization warning

    // bounds will go from 0 to physicalSize
    const physicalSize = this.getNormVolumeSize();
  }

  public cleanup(): void {
    // warning do not use after cleanup is called!
    this.volumeTexture.dispose();
  }

  public setRenderUpdateListener(callback?: (iteration: number) => void): void {
    this.renderUpdateListener = callback;
  }

  public resetProgress(): void {
    if (this.sampleCount !== 0 && this.renderUpdateListener) {
      this.renderUpdateListener(0);
    }
    this.sampleCount = 0;
  }

  private getNormVolumeSize(): Vector3 {
    return this.volume.normPhysicalSize.clone().multiply(this.settings.scale);
  }

  /**
   * If the new settings have changed, applies all changes to this volume renderer.
   * @param newSettings
   * @returns
   */
  public updateSettings(newSettings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags): void {
    if (dirtyFlags === undefined) {
      dirtyFlags = SettingsFlags.ALL;
    }
    this.settings = newSettings;

    // Update resolution
    if (dirtyFlags & SettingsFlags.SAMPLING) {

    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.updateMaterial();
    }

    // update bounds
    if (dirtyFlags & SettingsFlags.ROI) {
      const { normRegionSize, normRegionOffset } = this.volume;
      const { bmin, bmax } = this.settings.bounds;
      const scaledSize = this.getNormVolumeSize();

      const sizeMin = normRegionOffset.clone().subScalar(0.5).multiply(scaledSize);
      const sizeMax = normRegionOffset.clone().add(normRegionSize).subScalar(0.5).multiply(scaledSize);

      const clipMin = bmin.clone().multiply(scaledSize);
      // this.pathTracingUniforms.gClippedAaBbMin.value = clipMin.clamp(sizeMin, sizeMax);

      const clipMax = bmax.clone().multiply(scaledSize);
      // this.pathTracingUniforms.gClippedAaBbMax.value = clipMax.clamp(sizeMin, sizeMax);

      // this.pathTracingUniforms.gVolCenter.value = this.volume.getContentCenter().multiply(this.settings.scale);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
      this.updateExposure(this.settings.brightness);
    }

    if (dirtyFlags & SettingsFlags.MASK_ALPHA) {
      // Update channel and alpha mask if they have changed
      // this.updateVolumeData4();
    }
    if (dirtyFlags & SettingsFlags.VIEW) {

    }

    if (dirtyFlags & SettingsFlags.SAMPLING) {

      const resolution = this.settings.resolution.clone();
      for (let i = 0; i < this.renderTargets.length; i++) {
        this.renderTargets[i].setSize(resolution.x, resolution.y);
      }

      const filter = newSettings.useInterpolation
        ? LinearFilter
        : NearestFilter;

      this.volumeTexture.minFilter = filter;
      this.volumeTexture.magFilter = filter;
      this.volumeTexture.needsUpdate = true;
    }

    this.resetProgress();
  }

  public updateVolumeDimensions(): void {
    this.updateSettings(this.settings, SettingsFlags.ROI);
  }

  public doRender(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera): void {
    if (!this.volumeTexture) {
      return;
    }

    if (this.isCameraMoving) {
      this.resetProgress();
    }

    // force the camera to update its world matrix.
    camera.updateMatrixWorld(true);

    let ping = this.renderTargets[this.sampleCount % 2]; // buffer to read from
    let pong = this.renderTargets[(this.sampleCount + 1) % 2]; // buffer to write to

    this.uniforms.previous.value = ping.texture;
    this.uniforms.sampleSeed.value = Math.floor(Math.random() * 0x100000000);
    this.uniforms.sampleWeight.value = 1.0 / (this.sampleCount + 1);

    this.uniforms.resolution.value = new Uint32Array([pong.width, pong.height]);
    this.uniforms.invResolution.value = new Vector2(
      1.0 / pong.width,
      1.0 / pong.height,
    );

    const projectionMatrix = camera.projectionMatrix;
    const viewMatrix = camera.matrixWorldInverse;
    this.uniforms.invViewProjection.value = new Matrix4().multiplyMatrices(projectionMatrix, viewMatrix).invert();

    this.renderToBuffer.render(renderer, pong);

    // post processing will be done by ThreeJsPanel 
    // (since this.get3DObject returns the post process quad),
    // so we just need to set the relevant uniforms.
    this.postProcessUniforms.tHdr.value = pong.texture;

    this.sampleCount += 1;
    this.renderUpdateListener?.(this.sampleCount);
  }

  public get3dObject(): Mesh {
    return this.postProcessRenderToBuffer.mesh;
  }

  //////////////////////////////////////////
  //////////////////////////////////////////

  onStartControls(): void {
    this.isCameraMoving = true;
  }

  onChangeControls(): void {}

  onEndControls(): void {
    this.isCameraMoving = false;
    this.resetProgress();
  }

  viewpointMoved(): void {
    this.resetProgress();
  }

  updateActiveChannels(channelColors: FuseChannel[], channelData: Channel[]): void {
    this.updateVolumeData(channelColors[0].chIndex);
    
    let majorant = 0;    
    for (let i = 0; i < LUT_ENTRIES; i++) {
      const alpha = channelColors[0].lut[4 * i + 3] / 255;
      const extinction = this.alphaToExtinctionFactor * alpha;
      if (extinction > majorant) {
        majorant = extinction;
      }
    }
    this.uniforms.alphaToExtinctionFactor.value = this.alphaToExtinctionFactor;
    this.uniforms.majorant.value = majorant;

    this.lutTexture.image.data = channelColors[0].lut;
    this.lutTexture.needsUpdate = true;
    
    const normPhysicalSize = this.volume.normPhysicalSize;
    this.uniforms.volumeMin.value = normPhysicalSize.clone().multiplyScalar(-0.5);
    this.uniforms.volumeMax.value = normPhysicalSize.clone().multiplyScalar(0.5);
    this.uniforms.volumeInvSize.value = new Vector3(
      1.0 / normPhysicalSize.x,
      1.0 / normPhysicalSize.y,
      1.0 / normPhysicalSize.z,
    );
    
    const channel = this.volume.getChannel(channelColors[0].chIndex);
    this.uniforms.intensityMin.value = channel.rawMin;
    this.uniforms.intensityInvRange.value = 1.0 / (channel.rawMax - channel.rawMin);

    this.resetProgress();
  }

  updateVolumeData(channelIndex: number): void {
    const { x: sx, y: sy, z: sz } = this.volume.imageInfo.subregionSize;

    const data = new Float32Array(sx * sy * sz);

    const channel = this.volume.getChannel(channelIndex);
    for (let iz = 0; iz < sz; ++iz) {
      for (let iy = 0; iy < sy; ++iy) {
        for (let ix = 0; ix < sx; ++ix) {
          data[ix + iy * sx + iz * sx * sy] = channel.getIntensity(ix, iy, iz);
        }
      }
    }
    this.volumeTexture.image.data.set(data);
    this.volumeTexture.needsUpdate = true;
  }

  updateMaterial(): void {
    this.resetProgress();
  }

  updateExposure(e: number): void {

  }

  updateCamera(fov: number, focalDistance: number, apertureSize: number): void {

    this.resetProgress();
  }

  updateLights(state: Light[]): void {


    this.resetProgress();
  }


  // 0..1 ranges as input
  updateVisibleRegion(xmin: number, xmax: number, ymin: number, ymax: number, zmin: number, zmax: number): void {

    this.resetProgress();
  }

  public setZSlice(_slice: number): boolean {
    return true;
  }
}
