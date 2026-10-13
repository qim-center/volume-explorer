import {
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DepthTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import FusedChannelData from "./FusedChannelData.js";
import {
  rayMarchingVertexShaderSrc,
  rayMarchingFragmentShaderSrc,
  rayMarchingShaderUniforms,
} from "./constants/volumeRayMarchShader.js";
import { Volume } from "./index.js";
import Channel from "./Channel.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";

import type { FuseChannel } from "./types.js";
import { VolumeRenderSettings, SettingsFlags } from "./VolumeRenderSettings.js";

const BOUNDING_BOX_DEFAULT_COLOR = new Color(0xffff00);

export default class RayMarchedAtlasVolume implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;
  public volume: Volume;

  private geometry: BoxGeometry;
  private geometryMesh: Mesh<BufferGeometry, Material>;
  private boxHelper: Box3Helper;
  private tickMarksMesh: LineSegments;
  private geometryTransformNode: Group;
  private uniforms: ReturnType<typeof rayMarchingShaderUniforms>;
  private channelData!: FusedChannelData;
  private emptyPositionTex: DataTexture;

  /**
   * Creates a new RayMarchedAtlasVolume.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;

    this.uniforms = rayMarchingShaderUniforms();
    [this.geometry, this.geometryMesh] = this.createGeometry(this.uniforms);

    this.boxHelper = new Box3Helper(
      new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
      BOUNDING_BOX_DEFAULT_COLOR
    );
    this.boxHelper.updateMatrixWorld();
    this.boxHelper.visible = false;

    this.tickMarksMesh = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: BOUNDING_BOX_DEFAULT_COLOR })
    );
    this.tickMarksMesh.visible = false;

    this.geometryTransformNode = new Group();
    this.geometryTransformNode.name = "VolumeContainerNode";

    this.geometryTransformNode.add(this.boxHelper, this.tickMarksMesh, this.geometryMesh);

    this.emptyPositionTex = new DataTexture(new Uint8Array(Array(16).fill(0)), 2, 2);

    this.settings = settings;
    this.updateSettings(settings, SettingsFlags.ALL);
    // TODO this is doing *more* redundant work! Fix?
    this.updateVolumeDimensions();
  }

  public updateVolumeDimensions(): void {
    const { normPhysicalSize, normRegionSize } = this.volume;
    // Set offset
    this.geometryMesh.position.copy(this.volume.getContentCenter().multiply(this.settings.scale));
    // Set scale
    const fullRegionScale = normPhysicalSize.clone().multiply(this.settings.scale);
    this.geometryMesh.scale.copy(fullRegionScale).multiply(normRegionSize);
    this.setUniform("volumeScale", normPhysicalSize);
    this.settings && this.updateSettings(this.settings, SettingsFlags.ROI);

    // Set atlas dimension uniforms
    const { atlasTileDims, subregionSize } = this.volume.imageInfo;
    const atlasSize = new Vector2(subregionSize.x, subregionSize.y).multiply(atlasTileDims);

    this.setUniform("ATLAS_DIMS", atlasTileDims);

    this.setUniform("textureRes", atlasSize);
    this.setUniform("SLICES", subregionSize.z);

    // (re)create channel data
    if (!this.channelData || this.channelData.width !== atlasSize.x || this.channelData.height !== atlasSize.y) {
      this.channelData?.cleanup();
      this.channelData = new FusedChannelData(atlasSize.x, atlasSize.y);
    }

    this.applySamplingFiltering();
  }

  public viewpointMoved(): void {
    return;
  }

  public updateSettings(newSettings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags) {
    if (dirtyFlags === undefined) {
      dirtyFlags = SettingsFlags.ALL;
    }

    this.settings = newSettings;

    if (dirtyFlags & SettingsFlags.VIEW) {
      this.geometryMesh.visible = this.settings.visible;
      // Configure ortho
      this.setUniform("orthoScale", this.settings.orthoScale);
      this.setUniform("isOrtho", this.settings.isOrtho ? 1.0 : 0.0);
      // Ortho line thickness
      const axis = this.settings.viewAxis;
      if (this.settings.isOrtho && axis) {
        // TODO: Does this code do any relevant changes?
        const maxVal = this.settings.bounds.bmax[axis];
        const minVal = this.settings.bounds.bmin[axis];
        const thicknessPct = maxVal - minVal;
        this.setUniform("orthoThickness", thicknessPct);
      } else {
        this.setUniform("orthoThickness", 1.0);
      }
    }

    if (dirtyFlags & SettingsFlags.VIEW || dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      // Update tick marks with either view or bounding box changes
      this.tickMarksMesh.visible = this.settings.showBoundingBox && !this.settings.isOrtho;
      this.setUniform("maxProject", this.settings.maxProjectMode ? 1 : 0);
    }

    if (dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      // Configure bounding box
      this.boxHelper.visible = this.settings.showBoundingBox;
      const colorVector = this.settings.boundingBoxColor;
      const newBoxColor = new Color(colorVector[0], colorVector[1], colorVector[2]);
      (this.boxHelper.material as LineBasicMaterial).color = newBoxColor;
      (this.tickMarksMesh.material as LineBasicMaterial).color = newBoxColor;
    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      // Set rotation and translation
      this.geometryTransformNode.position.copy(this.settings.translation);
      this.geometryTransformNode.rotation.copy(this.settings.rotation);
      // TODO this does some redundant work. Including a new call to this very function! Fix?
      this.updateVolumeDimensions();
      this.setUniform("flipVolume", this.settings.flipAxes);
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.setUniform("DENSITY", this.settings.density);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
      // TODO brightness and exposure should be the same thing?
      this.setUniform("BRIGHTNESS", this.settings.brightness * 2.0);
      // Gamma
      this.setUniform("GAMMA_MIN", this.settings.gammaMin);
      this.setUniform("GAMMA_MAX", this.settings.gammaMax);
      this.setUniform("GAMMA_SCALE", this.settings.gammaLevel);
    }

    if (dirtyFlags & SettingsFlags.ROI) {
      // Normalize and set bounds
      const bounds = this.settings.bounds;
      const { normRegionSize, normRegionOffset } = this.volume;
      const offsetToCenter = normRegionSize.clone().divideScalar(2).add(normRegionOffset).subScalar(0.5);
      const bmin = bounds.bmin.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);
      const bmax = bounds.bmax.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);

      this.setUniform("AABB_CLIP_MIN", bmin);
      this.setUniform("AABB_CLIP_MAX", bmax);

      this.updateGrid();
    }

    if (dirtyFlags & SettingsFlags.SAMPLING) {
      this.setUniform("interpolationEnabled", !this.settings.isOrtho && this.settings.useInterpolation);
      this.applySamplingFiltering();
      this.setUniform("iResolution", this.settings.resolution);
    }

    if (dirtyFlags & SettingsFlags.MASK_ALPHA) {
      this.setUniform("maskAlpha", this.settings.maskChannelIndex < 0 ? 1.0 : this.settings.maskAlpha);
    }
    if (dirtyFlags & SettingsFlags.MASK_DATA) {
      this.channelData.setChannelAsMask(
        this.settings.maskChannelIndex,
        this.volume.getChannel(this.settings.maskChannelIndex)
      );
    }
  }

  /**
   * Creates the geometry mesh and material for rendering the volume.
   * @param uniforms object containing uniforms to pass to the shader material.
   * @returns the new geometry and geometry mesh.
   */
  private createGeometry(
    uniforms: ReturnType<typeof rayMarchingShaderUniforms>
  ): [BoxGeometry, Mesh<BufferGeometry, Material>] {
    const geom = new BoxGeometry(1.0, 1.0, 1.0);

    // shader,vtx and frag.

    const threeMaterial = new ShaderMaterial({
      uniforms: uniforms,
      vertexShader: rayMarchingVertexShaderSrc,
      fragmentShader: rayMarchingFragmentShaderSrc,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const mesh: Mesh<BufferGeometry, Material> = new Mesh(geom, threeMaterial);
    mesh.name = "Volume";

    return [geom, mesh];
  }

  private updateGrid(): void {
    const { bounds, scale } = this.settings;
    const { normPhysicalSize, physicalScale } = this.volume;

    const fullRegionScale = normPhysicalSize.clone().multiply(scale);
    const min = bounds.bmin.clone().multiply(fullRegionScale);
    const max = bounds.bmax.clone().multiply(fullRegionScale).max(min);
    this.boxHelper.box.set(min, max);

    const size = max.clone().sub(min);
    const tickLength = 0.025 * Math.max(size.x, size.y, size.z);
    const tickMarkPhysicalLength = this.volume.getRegionTickMarkPhysicalLength(bounds.bmin, bounds.bmax);
    const tickSpacing = scale.clone().multiplyScalar(tickMarkPhysicalLength / physicalScale);
    const numTicks = size.clone().divide(tickSpacing).floor();

    const vertices: number[] = [];

    for (let i = 0; i <= numTicks.x; i++) {
      const x = min.x + i * tickSpacing.x;
      // prettier-ignore
      vertices.push(
        x, max.y,              max.z,
        x, max.y + tickLength, max.z,

        x, min.y,              min.z,
        x, min.y - tickLength, min.z,

        x, max.y,              min.z,
        x, max.y + tickLength, min.z,

        x, min.y,              max.z,
        x, min.y - tickLength, max.z,
      );
    }

    for (let i = 0; i <= numTicks.y; i++) {
      const y = max.y - i * tickSpacing.y;
      // prettier-ignore
      vertices.push(
        min.x,              y, max.z,
        min.x - tickLength, y, max.z,

        min.x,              y, min.z,
        min.x - tickLength, y, min.z,

        max.x,              y, min.z,
        max.x + tickLength, y, min.z,

        max.x,              y, max.z,
        max.x + tickLength, y, max.z,
      );
    }

    for (let i = 0; i <= numTicks.z; i++) {
      const z = max.z - i * tickSpacing.z;
      // prettier-ignore
      vertices.push(
        min.x,              max.y, z,
        min.x - tickLength, max.y, z,

        min.x,              min.y, z,
        min.x - tickLength, min.y, z,

        max.x,              min.y, z,
        max.x + tickLength, min.y, z,

        max.x,              max.y, z,
        max.x + tickLength, max.y, z,
      );
    }

    this.tickMarksMesh.geometry.dispose();
    this.tickMarksMesh.geometry = new BufferGeometry();
    this.tickMarksMesh.geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
  }

  public cleanup(): void {
    this.geometry.dispose();
    this.geometryMesh.material.dispose();

    this.channelData.cleanup();
  }

  public doRender(
    renderer: WebGLRenderer,
    camera: PerspectiveCamera | OrthographicCamera,
    depthTexture?: DepthTexture | Texture | null
  ): void {
    if (!this.geometryMesh.visible) {
      return;
    }

    const depthTex = depthTexture ?? this.emptyPositionTex;
    this.setUniform("textureDepth", depthTex);
    this.setUniform("usingPositionTexture", (depthTex as DepthTexture).isDepthTexture ? 0 : 1);
    this.setUniform("CLIP_NEAR", camera.near);
    this.setUniform("CLIP_FAR", camera.far);

    this.channelData.gpuFuse(renderer);
    this.applySamplingFiltering();
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());

    this.geometryTransformNode.updateMatrixWorld(true);

    const mvm = new Matrix4();
    mvm.multiplyMatrices(camera.matrixWorldInverse, this.geometryMesh.matrixWorld);
    mvm.invert();

    this.setUniform("inverseModelViewMatrix", mvm);
    this.setUniform("inverseProjMatrix", camera.projectionMatrixInverse);
  }

  public get3dObject(): Group {
    return this.geometryTransformNode;
  }

  //////////////////////////////////////////
  //////////////////////////////////////////

  private setUniform<U extends keyof ReturnType<typeof rayMarchingShaderUniforms>>(
    name: U,
    value: ReturnType<typeof rayMarchingShaderUniforms>[U]["value"]
  ) {
    if (!this.uniforms[name]) {
      return;
    }
    this.uniforms[name].value = value;
  }

  private applySamplingFiltering(): void {
    if (!this.channelData) {
      return;
    }

    const filter = !this.settings.isOrtho && this.settings.useInterpolation ? LinearFilter : NearestFilter;
    const fusedTexture = this.channelData.getFusedTexture();
    if (fusedTexture.minFilter !== filter || fusedTexture.magFilter !== filter) {
      fusedTexture.minFilter = filter;
      fusedTexture.magFilter = filter;
      fusedTexture.needsUpdate = true;
    }

    if (this.channelData.maskTexture.minFilter !== filter || this.channelData.maskTexture.magFilter !== filter) {
      this.channelData.maskTexture.minFilter = filter;
      this.channelData.maskTexture.magFilter = filter;
      this.channelData.maskTexture.needsUpdate = true;
    }
  }

  // channelcolors is array of {rgbColor, lut} and channeldata is volume.channels
  public updateActiveChannels(channelcolors: FuseChannel[], channeldata: Channel[]): void {
    this.channelData.fuse(channelcolors, channeldata);

    // update to fused texture
    this.setUniform("textureAtlas", this.channelData.getFusedTexture());
    this.setUniform("textureAtlasMask", this.channelData.maskTexture);
  }

  public setRenderUpdateListener(_listener?: ((iteration: number) => void) | undefined) {
    return;
  }
}
