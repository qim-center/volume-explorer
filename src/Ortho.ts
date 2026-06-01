import {
  Box3,
  Box3Helper,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  Material,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  DoubleSide,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import { Volume } from ".";
import { sliceFragmentShaderSrc, sliceShaderUniforms, sliceVertexShaderSrc } from "./constants/volumeSliceShader.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";
import { Axis, SettingsFlags, VolumeRenderSettings } from "./VolumeRenderSettings.js";
import FusedChannelData from "./FusedChannelData.js";
import type { FuseChannel } from "./types.js";
import Channel from "./Channel.js";

const BOUNDING_BOX_DEFAULT_COLOR = new Color(0xffff00);

type SlicePlane = {
  axis: Axis;
  mesh: Mesh<BufferGeometry, Material>;
  uniforms: ReturnType<typeof sliceShaderUniforms>;
};

const AXIS_INDEX: Record<Axis, number> = {
  [Axis.X]: 0,
  [Axis.Y]: 1,
  [Axis.Z]: 2,
  [Axis.NONE]: 2,
  [Axis.XYZ]: 2,
};

/**
 * Renders three orthogonal slices (XY, XZ, YZ) in an orthographic view.
 */
export default class Ortho implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;
  public volume: Volume;
  private geometry: PlaneGeometry;
  private geometryTransformNode: Group;
  private boxHelper: Box3Helper;
  private planes: SlicePlane[];
  private channelData!: FusedChannelData;

  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;

    this.geometry = new PlaneGeometry(1.0, 1.0);
    this.geometryTransformNode = new Group();
    this.geometryTransformNode.name = "VolumeContainerNode";

    this.boxHelper = new Box3Helper(
      new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
      BOUNDING_BOX_DEFAULT_COLOR
    );
    this.boxHelper.updateMatrixWorld();
    this.boxHelper.visible = false;

    this.planes = [Axis.X, Axis.Y, Axis.Z].map((axis) => this.createPlane(axis));

    this.geometryTransformNode.add(this.boxHelper, ...this.planes.map((plane) => plane.mesh));

    this.settings = settings;
    this.updateVolumeDimensions();
    this.updateSettings(settings, SettingsFlags.ALL);
  }

  private createPlane(axis: Axis): SlicePlane {
    const uniforms = sliceShaderUniforms();
    uniforms.sliceAxis.value = AXIS_INDEX[axis];

    const material = new ShaderMaterial({
      uniforms: uniforms,
      vertexShader: sliceVertexShaderSrc,
      fragmentShader: sliceFragmentShaderSrc,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: DoubleSide,
    });

    const mesh = new Mesh(this.geometry, material);
    mesh.name = `SlicePlane${axis.toUpperCase()}`;

    return { axis, mesh, uniforms };
  }

  private setUniformForAll<U extends keyof ReturnType<typeof sliceShaderUniforms>>(
    name: U,
    value: ReturnType<typeof sliceShaderUniforms>[U]["value"]
  ) {
    for (const plane of this.planes) {
      if (!plane.uniforms[name]) {
        continue;
      }
      plane.uniforms[name].value = value;
    }
  }

  private getSliceIndex(axis: Axis): number {
    switch (axis) {
      case Axis.X:
        return this.settings.xSlice;
      case Axis.Y:
        return this.settings.ySlice;
      case Axis.Z:
        return this.settings.zSlice;
      default:
        return 0;
    }
  }

  private getSliceCoord(axis: Axis): number {
    const axisKey = axis as "x" | "y" | "z";
    const axisSize = Math.max(1, Math.floor(this.volume.imageInfo.volumeSize[axisKey]));
    const maxIndex = Math.max(1, axisSize - 1);
    const clampedIndex = Math.min(maxIndex, Math.max(0, Math.floor(this.getSliceIndex(axis))));

    if (axisSize <= 1) {
      return 0.5;
    }

    return clampedIndex / maxIndex;
  }

  private updatePlaneTransforms(regionScale: Vector3, volumeOffset: Vector3): void {
    for (const plane of this.planes) {
      const sliceCoord = this.getSliceCoord(plane.axis);
      plane.uniforms.sliceCoord.value = sliceCoord;

      const position = volumeOffset.clone();
      if (plane.axis === Axis.X) {
        position.x += (sliceCoord - 0.5) * regionScale.x;
        plane.mesh.rotation.set(0, Math.PI * 0.5, Math.PI * 0.5);
        plane.mesh.scale.set(regionScale.y, regionScale.z, 1);
      } else if (plane.axis === Axis.Y) {
        position.y += (sliceCoord - 0.5) * regionScale.y;
        plane.mesh.rotation.set(Math.PI * 0.5, 0, 0);
        plane.mesh.scale.set(regionScale.x, regionScale.z, 1);
      } else {
        position.z += (sliceCoord - 0.5) * regionScale.z;
        plane.mesh.rotation.set(0, 0, 0);
        plane.mesh.scale.set(regionScale.x, regionScale.y, 1);
      }

      plane.mesh.position.copy(position);
    }
  }

  public updateVolumeDimensions(): void {
    const volumeScale = this.volume.normPhysicalSize.clone().multiply(this.settings.scale);
    const regionScale = volumeScale.clone().multiply(this.volume.normRegionSize);
    const volumeOffset = this.volume.getContentCenter().clone().multiply(this.settings.scale);

    this.updatePlaneTransforms(regionScale, volumeOffset);

    this.setUniformForAll("volumeScale", regionScale);

    this.boxHelper.box.set(volumeScale.clone().multiplyScalar(-0.5), volumeScale.clone().multiplyScalar(0.5));

    const { atlasTileDims, subregionSize } = this.volume.imageInfo;
    const atlasSize = new Vector2(subregionSize.x, subregionSize.y).multiply(atlasTileDims);

    this.setUniformForAll("ATLAS_DIMS", atlasTileDims);
    this.setUniformForAll("textureRes", atlasSize);
    this.setUniformForAll("SLICES", subregionSize.z);

    if (!this.channelData || this.channelData.width !== atlasSize.x || this.channelData.height !== atlasSize.y) {
      this.channelData?.cleanup();
      this.channelData = new FusedChannelData(atlasSize.x, atlasSize.y);
    }

    this.applyNearestFiltering();
  }

  private applyNearestFiltering(): void {
    const fusedTexture = this.channelData.getFusedTexture();
    if (fusedTexture.minFilter !== NearestFilter || fusedTexture.magFilter !== NearestFilter) {
      fusedTexture.minFilter = NearestFilter;
      fusedTexture.magFilter = NearestFilter;
      fusedTexture.needsUpdate = true;
    }

    if (
      this.channelData.maskTexture.minFilter !== NearestFilter ||
      this.channelData.maskTexture.magFilter !== NearestFilter
    ) {
      this.channelData.maskTexture.minFilter = NearestFilter;
      this.channelData.maskTexture.magFilter = NearestFilter;
      this.channelData.maskTexture.needsUpdate = true;
    }
  }

  public updateSettings(newSettings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags) {
    if (dirtyFlags === undefined) {
      dirtyFlags = SettingsFlags.ALL;
    }

    this.settings = newSettings;

    if (dirtyFlags & SettingsFlags.VIEW) {
      for (const plane of this.planes) {
        plane.mesh.visible = this.settings.visible;
      }
      this.setUniformForAll("orthoScale", this.settings.orthoScale);
      this.setUniformForAll("isOrtho", this.settings.isOrtho ? 1.0 : 0.0);
      this.setUniformForAll("orthoThickness", 1.0);
    }

    if (dirtyFlags & SettingsFlags.BOUNDING_BOX) {
      this.boxHelper.visible = this.settings.showBoundingBox;
      const colorVector = this.settings.boundingBoxColor;
      const newBoxColor = new Color(colorVector[0], colorVector[1], colorVector[2]);
      (this.boxHelper.material as LineBasicMaterial).color = newBoxColor;
    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      this.geometryTransformNode.position.copy(this.settings.translation);
      this.geometryTransformNode.rotation.copy(this.settings.rotation);
      this.setUniformForAll("flipVolume", this.settings.flipAxes);
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.setUniformForAll("DENSITY", this.settings.density);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
      this.setUniformForAll("BRIGHTNESS", this.settings.brightness * 2.0);
      this.setUniformForAll("GAMMA_MIN", this.settings.gammaMin);
      this.setUniformForAll("GAMMA_MAX", this.settings.gammaMax);
      this.setUniformForAll("GAMMA_SCALE", this.settings.gammaLevel);
    }

    if (dirtyFlags & SettingsFlags.ROI) {
      const bounds = this.settings.bounds;
      const { normRegionSize, normRegionOffset } = this.volume;
      const offsetToCenter = normRegionSize.clone().divideScalar(2).add(normRegionOffset).subScalar(0.5);
      const bmin = bounds.bmin.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);
      const bmax = bounds.bmax.clone().sub(offsetToCenter).divide(normRegionSize).clampScalar(-0.5, 0.5);

      this.setUniformForAll("AABB_CLIP_MIN", bmin);
      this.setUniformForAll("AABB_CLIP_MAX", bmax);

      const volumeScale = this.volume.normPhysicalSize.clone().multiply(this.settings.scale);
      const regionScale = volumeScale.clone().multiply(this.volume.normRegionSize);
      const volumeOffset = this.volume.getContentCenter().clone().multiply(this.settings.scale);
      this.updatePlaneTransforms(regionScale, volumeOffset);
    }

    if (dirtyFlags & SettingsFlags.SAMPLING) {
      this.setUniformForAll("interpolationEnabled", false);
      this.setUniformForAll("iResolution", this.settings.resolution);
    }

    if (dirtyFlags & SettingsFlags.MASK_ALPHA) {
      this.setUniformForAll("maskAlpha", this.settings.maskChannelIndex < 0 ? 1.0 : this.settings.maskAlpha);
    }
    if (dirtyFlags & SettingsFlags.MASK_DATA) {
      this.channelData.setChannelAsMask(
        this.settings.maskChannelIndex,
        this.volume.getChannel(this.settings.maskChannelIndex)
      );
    }
  }

  public updateActiveChannels(channelcolors: FuseChannel[], channeldata: Channel[]): void {
    this.channelData.fuse(channelcolors, channeldata);
    this.setUniformForAll("textureAtlas", this.channelData.getFusedTexture());
    this.setUniformForAll("textureAtlasMask", this.channelData.maskTexture);
  }

  public doRender(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera): void {
    const anyVisible = this.planes.some((plane) => plane.mesh.visible);
    if (!anyVisible) {
      return;
    }

    this.channelData.gpuFuse(renderer);
    this.setUniformForAll("textureAtlas", this.channelData.getFusedTexture());
    this.setUniformForAll("textureAtlasMask", this.channelData.maskTexture);

    this.geometryTransformNode.updateMatrixWorld(true);

    for (const plane of this.planes) {
      if (!plane.mesh.visible) {
        continue;
      }
      plane.mesh.updateMatrixWorld(true);
      const mvm = new Matrix4();
      mvm.multiplyMatrices(camera.matrixWorldInverse, plane.mesh.matrixWorld);
      const mi = new Matrix4();
      mi.copy(mvm).invert();
      plane.uniforms.inverseModelViewMatrix.value = mi;
    }
  }

  public get3dObject(): Group {
    return this.geometryTransformNode;
  }

  public cleanup(): void {
    this.geometry.dispose();
    for (const plane of this.planes) {
      plane.mesh.material.dispose();
    }
    this.channelData.cleanup();
  }

  public viewpointMoved(): void {
    return;
  }

  public setRenderUpdateListener(_listener?: ((iteration: number) => void) | undefined) {
    return;
  }
}