import {
  Box3,
  Box3Helper,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
} from "three";

import type Volume from "./Volume.js";
import { Axis, type VolumeRenderSettings } from "./VolumeRenderSettings.js";

const DEFAULT_COLOR = new Color(0xffff00);
const TICK_LENGTH = 0.025;

const AXES = [Axis.X, Axis.Y, Axis.Z] as const;
const TICK_DIRECTION = [1, 0, 0];
const TICKS_FROM_MAX = [false, true, true];

/** The bounding box and tick marks drawn around the visible (cropped) region of a volume */
export default class GridLines extends Group {
  private box: Box3Helper;
  private tickMarks: LineSegments<BufferGeometry, LineBasicMaterial>;

  constructor() {
    super();
    this.name = "GridLines";
    this.visible = false;

    this.box = new Box3Helper(new Box3(), DEFAULT_COLOR);
    this.tickMarks = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: DEFAULT_COLOR }));
    this.add(this.box, this.tickMarks);
  }

  public update(volume: Volume, settings: VolumeRenderSettings, viewAxisCenter?: number): void {
    const { bounds, scale, viewAxis, showBoundingBox, boundingBoxColor } = settings;

    this.visible = showBoundingBox;
    (this.box.material as LineBasicMaterial).color.setRGB(...boundingBoxColor);
    this.tickMarks.material.color.setRGB(...boundingBoxColor);

    const fullRegionScale = volume.normPhysicalSize.clone().multiply(scale);
    const min = bounds.bmin.clone().multiply(fullRegionScale);
    const max = bounds.bmax.clone().multiply(fullRegionScale).max(min);
    const viewAxisIndex = AXES.indexOf(viewAxis as (typeof AXES)[number]);
    if (viewAxisIndex >= 0 && viewAxisCenter !== undefined) {
      const halfDepth = (max.getComponent(viewAxisIndex) - min.getComponent(viewAxisIndex)) / 2;
      min.setComponent(viewAxisIndex, viewAxisCenter - halfDepth);
      max.setComponent(viewAxisIndex, viewAxisCenter + halfDepth);
    }
    this.box.box.set(min, max);

    const size = max.clone().sub(min);
    const tickLength = TICK_LENGTH * Math.max(size.x, size.y, size.z);
    const tickMarkPhysicalLength = volume.getRegionTickMarkPhysicalLength(bounds.bmin, bounds.bmax);
    const tickSpacing = scale.clone().multiplyScalar(tickMarkPhysicalLength / volume.physicalScale);
    const numTicks = size.clone().divide(tickSpacing).floor();

    const vertices: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      if (axis === viewAxisIndex) {
        continue;
      }
      const tickAxis = TICK_DIRECTION[axis] === viewAxisIndex ? 3 - axis - viewAxisIndex : TICK_DIRECTION[axis];
      const otherAxis = 3 - axis - tickAxis;

      for (let i = 0; i <= numTicks.getComponent(axis); i++) {
        const offset = i * tickSpacing.getComponent(axis);
        const vertex = [0, 0, 0];
        vertex[axis] = TICKS_FROM_MAX[axis] ? max.getComponent(axis) - offset : min.getComponent(axis) + offset;

        for (const tickEnd of [min, max]) {
          for (const otherEnd of [min, max]) {
            vertex[otherAxis] = otherEnd.getComponent(otherAxis);
            vertex[tickAxis] = tickEnd.getComponent(tickAxis);
            vertices.push(...vertex);
            vertex[tickAxis] += tickEnd === max ? tickLength : -tickLength;
            vertices.push(...vertex);
          }
        }
      }
    }

    this.tickMarks.geometry.dispose();
    this.tickMarks.geometry = new BufferGeometry();
    this.tickMarks.geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
  }

  public cleanup(): void {
    this.box.geometry.dispose();
    (this.box.material as LineBasicMaterial).dispose();
    this.tickMarks.geometry.dispose();
    this.tickMarks.material.dispose();
  }
}