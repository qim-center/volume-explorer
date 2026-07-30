import {
  Camera,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
} from "three";

import { MESH_NO_PICK_OCCLUSION_LAYER } from "./ThreeJsPanel.js";

export interface CropRegion {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  zmin: number;
  zmax: number;
}


export type CropHandlesChangeHandler = (region: CropRegion, committed: boolean) => void;

interface CropHandlesDeps {
  scene: Scene;
  getCamera: () => Camera;
  getCanvas: () => HTMLCanvasElement;
  getControls: () => { enabled: boolean };
  getVolumeExtent: () => Vector3 | null;
  redraw: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

interface Handle {
  axis: 0 | 1 | 2;
  side: "min" | "max";
  mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
}

const HANDLE_COLOR = 0xd8bfd8; // match toolbar colour scheme
const HANDLE_COLOR_ACTIVE = 0xdda0dd;
const MIN_GAP = 1e-3;
const HANDLE_RADIUS_FRACTION = 0.02;

const MIN_KEYS = ["xmin", "ymin", "zmin"] as const;
const MAX_KEYS = ["xmax", "ymax", "zmax"] as const;

// self-contained handle spheres
export default class CropHandles {
  private deps: CropHandlesDeps;
  private group: Object3D;
  private handles: Handle[] = [];
  private geometry: SphereGeometry;
  private region: CropRegion = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
  private enabled = false;
  private hiddenForCapture = false;
  private changeHandler?: CropHandlesChangeHandler;
  private raycaster = new Raycaster();
  private dragging: Handle | null = null;

  constructor(deps: CropHandlesDeps) {
    this.deps = deps;

    this.group = new Object3D();
    this.group.name = "CropHandles";
    this.group.visible = false;

    this.geometry = new SphereGeometry(1, 24, 16);
    for (const axis of [0, 1, 2] as const) {
      for (const side of ["min", "max"] as const) {

        const material = new MeshBasicMaterial({ color: HANDLE_COLOR });
        const mesh = new Mesh(this.geometry, material);
        mesh.layers.set(MESH_NO_PICK_OCCLUSION_LAYER);
        this.group.add(mesh);
        this.handles.push({ axis, side, mesh });
      }
    }

    this.raycaster.layers.set(MESH_NO_PICK_OCCLUSION_LAYER);

    this.deps.scene.add(this.group);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onHoverMove = this.onHoverMove.bind(this);
  }

  public setChangeHandler(handler: CropHandlesChangeHandler | undefined): void {
    this.changeHandler = handler;
  }

  public setRegion(region: CropRegion): void {
    this.region = { ...region };
    this.updatePositions();
    if (this.enabled) {
      this.deps.redraw();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setHiddenForCapture(hidden: boolean): void {
    if (this.hiddenForCapture === hidden) {
      return;
    }
    this.hiddenForCapture = hidden;
    this.updatePositions();
    this.deps.redraw();
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;

    const canvas = this.deps.getCanvas();
    if (enabled) {
      
      canvas.addEventListener("pointerdown", this.onPointerDown, true);
      canvas.addEventListener("pointermove", this.onHoverMove);
      this.updatePositions();
    } else {
      this.group.visible = false;
      canvas.removeEventListener("pointerdown", this.onPointerDown, true);
      canvas.removeEventListener("pointermove", this.onHoverMove);
      this.endDrag(canvas);
      canvas.style.cursor = "";
    }
    this.deps.redraw();
  }

  public dispose(): void {
    this.setEnabled(false);
    this.deps.scene.remove(this.group);
    this.geometry.dispose();
    for (const handle of this.handles) {
      handle.mesh.material.dispose();
    }
    this.handles = [];
  }


  private updatePositions(): void {
    const extent = this.deps.getVolumeExtent();
    
    this.group.visible = this.enabled && !this.hiddenForCapture && !!extent;
    if (!extent) {
      return;
    }
    const e = [extent.x, extent.y, extent.z];
    const radius = HANDLE_RADIUS_FRACTION * Math.max(e[0], e[1], e[2]);
    const centerFrac = [
      (this.region.xmin + this.region.xmax) / 2,
      (this.region.ymin + this.region.ymax) / 2,
      (this.region.zmin + this.region.zmax) / 2,
    ];
    const bmin = [this.region.xmin, this.region.ymin, this.region.zmin];
    const bmax = [this.region.xmax, this.region.ymax, this.region.zmax];

    for (const handle of this.handles) {
      const frac = handle.side === "min" ? bmin[handle.axis] : bmax[handle.axis];
      const pos = new Vector3();
      for (let a = 0; a < 3; a++) {
        const f = a === handle.axis ? frac : centerFrac[a];
        pos.setComponent(a, (f - 0.5) * e[a]);
      }
      handle.mesh.position.copy(pos);
      handle.mesh.scale.setScalar(radius);
    }
  }

  private pointerToNdc(event: PointerEvent): Vector2 {
    const rect = this.deps.getCanvas().getBoundingClientRect();
    return new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  private pickHandle(event: PointerEvent): Handle | null {
    this.raycaster.setFromCamera(this.pointerToNdc(event), this.deps.getCamera());
    const meshes = this.handles.map((h) => h.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) {
      return null;
    }
    return this.handles.find((h) => h.mesh === hits[0].object) ?? null;
  }

  
  private computeAxisFraction(event: PointerEvent, handle: Handle): number {
    const extent = this.deps.getVolumeExtent();
    const currentFrac = handle.side === "min" ? this.region[MIN_KEYS[handle.axis]] : this.region[MAX_KEYS[handle.axis]];
    if (!extent) {
      return currentFrac;
    }

    this.raycaster.setFromCamera(this.pointerToNdc(event), this.deps.getCamera());
    const ray = this.raycaster.ray;

    // line a is the handle slice axis
    const a0 = handle.mesh.position.clone();
    const da = new Vector3();
    da.setComponent(handle.axis, 1);

    // closest point on lina a to the camera ray b
    const w0 = a0.clone().sub(ray.origin);
    const b = da.dot(ray.direction);
    const d = da.dot(w0);
    const eDot = ray.direction.dot(w0);
    const denom = 1 - b * b;

    // if the ray from the camera is nearly parallel, holds position. otherwise, it would be too sensitive
    const s = Math.abs(denom) < 1e-6 ? 0 : (b * eDot - d) / denom;

    const newAxisWorld = a0.getComponent(handle.axis) + s;
    return newAxisWorld / extent.getComponent(handle.axis) + 0.5;
  }

  private applyDrag(handle: Handle, frac: number, committed: boolean): void {
    const clamped = Math.min(1, Math.max(0, frac));
    const region: CropRegion = { ...this.region };
    if (handle.side === "min") {
      region[MIN_KEYS[handle.axis]] = Math.max(0, Math.min(clamped, region[MAX_KEYS[handle.axis]] - MIN_GAP));
    } else {
      region[MAX_KEYS[handle.axis]] = Math.min(1, Math.max(clamped, region[MIN_KEYS[handle.axis]] + MIN_GAP));
    }
    this.region = region;
    this.updatePositions();
    this.deps.redraw();
    this.changeHandler?.(region, committed);
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.enabled || event.button !== 0) {
      return;
    }
    const handle = this.pickHandle(event);
    if (!handle) {
      return;
    }
    
    event.stopImmediatePropagation();
    event.preventDefault();

    this.dragging = handle;
    handle.mesh.material.color.set(HANDLE_COLOR_ACTIVE);
    this.deps.getControls().enabled = false;
    this.deps.onInteractionStart?.();

    const canvas = this.deps.getCanvas();
    canvas.setPointerCapture(event.pointerId);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.style.cursor = "grabbing";
    this.deps.redraw();
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    event.preventDefault();
    this.applyDrag(this.dragging, this.computeAxisFraction(event, this.dragging), false);
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    event.preventDefault();
    const handle = this.dragging;
    this.applyDrag(handle, this.computeAxisFraction(event, handle), true);
    this.endDrag(this.deps.getCanvas(), event.pointerId);
  }

  private endDrag(canvas: HTMLCanvasElement, pointerId?: number): void {
    if (!this.dragging) {
      return;
    }
    this.dragging.mesh.material.color.set(HANDLE_COLOR);
    this.dragging = null;
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.style.cursor = "";
    this.deps.getControls().enabled = true;
    this.deps.onInteractionEnd?.();
    this.deps.redraw();
  }

  private onHoverMove(event: PointerEvent): void {
    if (!this.enabled || this.dragging) {
      return;
    }
    this.deps.getCanvas().style.cursor = this.pickHandle(event) ? "grab" : "";
  }
}
