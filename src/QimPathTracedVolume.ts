import {
  DataTexture,
  Data3DTexture,
  FloatType,
  Matrix4,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  WebGLRenderer,
  RedFormat,
  Vector2,
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

  // Resources related to sampling
  private uniforms = qimPathTraceUniforms();
  private renderToBuffer: RenderToBuffer;
  // two render targets to do ping-pong with
  private renderTargets: WebGLRenderTarget[] = [];

  // Resources related to post processing
  private postProcessUniforms = qimPostProcessUniforms();
  private postProcessRenderToBuffer: RenderToBuffer;

  private isCameraMoving: boolean = false;
  private sampleCount: number = 0;

  private renderUpdateListener?: (iteration: number) => void;

  /**
   * Creates a new QimPathTracedVolume.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;

    // create volume texture
    const { x: sx, y: sy, z: sz } = volume.imageInfo.subregionSize;
    const data = new Float32Array(sx * sy * sz).fill(0.0);
    
    // defaults to rgba and unsignedbytetype so dont need to supply format this time.
    this.volumeTexture = new Data3DTexture(data, sx, sy, sz);
    this.volumeTexture.format = RedFormat;
    this.volumeTexture.type = FloatType;
    this.volumeTexture.minFilter = NearestFilter;
    this.volumeTexture.magFilter = NearestFilter;
    this.volumeTexture.generateMipmaps = false;


    this.volumeTexture.needsUpdate = true;

    this.uniforms.volume.value = this.volumeTexture;

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

    // initialize texture.
    this.renderToBuffer = new RenderToBuffer(qimPathTraceFragmentShaderSrc, this.uniforms);
    this.postProcessRenderToBuffer= new RenderToBuffer(qimPostProcessFragmentShaderSrc, this.postProcessUniforms);

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
      // this.pathTracingUniforms.gCamera.value.mIsOrtho = this.settings.isOrtho ? 1 : 0;
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

    this.sampleCount += 1;
    this.renderUpdateListener?.(this.sampleCount);

    // force the camera to update its world matrix.
    camera.updateMatrixWorld(true);

    let ping = this.renderTargets[this.sampleCount % 2]; // buffer to read from
    let pong = this.renderTargets[(this.sampleCount + 1) % 2]; // buffer to write to

    this.uniforms.invResolution.value = new Vector2(
      1.0 / pong.width,
      1.0 / pong.height,
    );

    const projectionMatrix = camera.projectionMatrix;
    const viewMatrix = camera.matrixWorldInverse;

    const normPhysicalSize = this.volume.normPhysicalSize;

    this.uniforms.invViewProjection.value = new Matrix4().multiplyMatrices(projectionMatrix, viewMatrix).invert();
    this.uniforms.volumeMin.value = normPhysicalSize.clone().multiplyScalar(-0.5);
    this.uniforms.volumeMax.value = normPhysicalSize.clone().multiplyScalar(0.5);
    this.uniforms.volumeInvSize.value = new Vector3(
      1.0 / normPhysicalSize.x,
      1.0 / normPhysicalSize.y,
      1.0 / normPhysicalSize.z,
    );

    this.renderToBuffer.render(renderer, pong);

    // post processing will be done by ThreeJsPanel 
    // (since this.get3DObject returns the post process quad),
    // so we just need to set the relevant uniforms.
    this.postProcessUniforms.tHdr.value = pong.texture;
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
    // const ch = [-1, -1, -1, -1];
    // let activeChannel = 0;
    // const NC = this.volume.imageInfo.numChannels;
    // const maxch = 4;
    // for (let i = 0; i < NC && activeChannel < maxch; ++i) {
    //   // check that channel is not disabled and is loaded
    //   if (channelColors[i].rgbColor !== FUSE_DISABLED_RGB_COLOR && channelData[i].loaded) {
    //     ch[activeChannel] = i;
    //     activeChannel++;
    //   }
    // }

    // const unchanged = ch.every((elem, index) => elem === this.viewChannels[index], this);
    // if (unchanged) {
    //   return;
    // }

    // this.pathTracingUniforms.gNChannels.value = activeChannel;

    // this.viewChannels = ch;
    // update volume data according to channels selected.
    this.updateVolumeData();
    this.updateMaterial();
    this.resetProgress();
  }

  updateVolumeData(): void {
    const { x: sx, y: sy, z: sz } = this.volume.imageInfo.subregionSize;

    const data = new Float32Array(sx * sy * sz);

    const channel = this.volume.getChannel(0);
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
