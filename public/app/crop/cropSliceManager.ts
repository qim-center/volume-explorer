import { Volume, View3d } from "../../../src";
import { State } from "../../types";
import { CameraMode, CROP_AXES, CropAxis, cropAxisStateKeys } from "../state/stateService";
import { createDualSlider, DualSlider } from "../ui/dualSlider";

interface CropSliceManagerOptions {
  state: State;
  getView3D: () => View3d;
  goToZSlice: (slice: number) => boolean;
  onCropRegionApplied?: () => void;
}

export function createCropSliceManager(options: CropSliceManagerOptions) {
  const { state, getView3D, goToZSlice, onCropRegionApplied } = options;

  let activeSliceAxis: CropAxis | null = null;
  let isMultiSliceMode = false;
  const sliceIndexByAxis: Record<CropAxis, number> = {
    x: 0,
    y: 0,
    z: 0,
  };

  const sliceMaxIndexByAxis: Record<CropAxis, number> = {
    x: 0,
    y: 0,
    z: 0,
  };

  const cropSliders: Partial<Record<CropAxis, DualSlider>> = {};

  function setSliceIndexForAxis(axis: CropAxis, sliceIndex: number) {
    if (axis === "z") {
      goToZSlice(sliceIndex);
      return;
    }

    getView3D().setSliceIndex(state.volume, axis, sliceIndex);
  }

  function getAxisVoxelCount(axis: CropAxis): number {
    const axisValue = state.volume.imageInfo?.volumeSize?.[axis];
    const value = Number(axisValue ?? 1);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }

  function getAxisMaxSliceIndex(axis: CropAxis): number {
    return Math.max(0, getAxisVoxelCount(axis) - 1);
  }

  function getAxisMaxSliceIndexForVolume(volume: Volume, axis: CropAxis): number {
    const axisValue = volume.imageInfo?.volumeSize?.[axis];
    const value = Number(axisValue ?? 1);
    const voxelCount = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    return Math.max(0, voxelCount - 1);
  }

  function remapSliceIndicesForRescaledVolume(volume: Volume) {
    for (const axis of ["x", "y"] as CropAxis[]) {
      const previousMax = sliceMaxIndexByAxis[axis];
      const nextMax = getAxisMaxSliceIndexForVolume(volume, axis);

      let nextIndex = sliceIndexByAxis[axis];
      if (previousMax !== nextMax) {
        const normalized = previousMax > 0 ? sliceIndexByAxis[axis] / previousMax : 0;
        nextIndex = Math.round(normalized * nextMax);
      }

      sliceIndexByAxis[axis] = Math.max(0, Math.min(nextMax, nextIndex));
      sliceMaxIndexByAxis[axis] = nextMax;
    }
  }

  function clampSliceIndex(axis: CropAxis, sliceIndex: number): number {
    const maxSliceIndex = getAxisMaxSliceIndex(axis);
    return Math.min(maxSliceIndex, Math.max(0, Math.round(sliceIndex)));
  }

  function getSliceCropBounds(axis: CropAxis, sliceIndex: number): { min: number; max: number } {
    const voxelCount = getAxisVoxelCount(axis);
    const maxIndex = getAxisMaxSliceIndex(axis);
    const clampedIndex = clampSliceIndex(axis, sliceIndex);
    sliceIndexByAxis[axis] = clampedIndex;

    const normalized = maxIndex > 0 ? clampedIndex / maxIndex : 0;
    const sliceThickness = Math.max(1 / voxelCount, 0.000001);
    const halfThickness = sliceThickness * 0.5;

    let min = normalized - halfThickness;
    let max = normalized + halfThickness;

    if (min < 0) {
      max = Math.min(1, max - min);
      min = 0;
    }
    if (max > 1) {
      min = Math.max(0, min - (max - 1));
      max = 1;
    }

    return { min, max };
  }

  function getEffectiveAxisCropBounds(axis: CropAxis): { min: number; max: number } {
    if (activeSliceAxis === axis) {
      return getSliceCropBounds(axis, sliceIndexByAxis[axis]);
    }

    const minKey = cropAxisStateKeys[axis].min;
    const maxKey = cropAxisStateKeys[axis].max;
    return {
      min: state[minKey] as number,
      max: state[maxKey] as number,
    };
  }

  function getStateAxisCropBounds(axis: CropAxis): { min: number; max: number } {
    const minKey = cropAxisStateKeys[axis].min;
    const maxKey = cropAxisStateKeys[axis].max;
    return {
      min: state[minKey] as number,
      max: state[maxKey] as number,
    };
  }

  function getEffectiveAxisLoadBounds(axis: CropAxis): { min: number; max: number } {
    if (isMultiSliceMode || activeSliceAxis === axis) {
      return { min: 0, max: 1 };
    }
    return getStateAxisCropBounds(axis);
  }

  function setUiSectionDisabled(section: HTMLElement | null, isDisabled: boolean) {
    if (!section) {
      return;
    }
    section.classList.toggle("is-disabled", isDisabled);
    section.setAttribute("aria-disabled", isDisabled ? "true" : "false");
  }

  function setCropAxisControlsDisabled(axis: CropAxis, isDisabled: boolean) {
    const row = document.getElementById(`crop-row-${axis}`) as HTMLElement | null;
    setUiSectionDisabled(row, isDisabled);

    for (const id of [`crop-${axis}-left`, `crop-${axis}-right`]) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) {
        input.disabled = isDisabled;
      }
    }

    const slider = row?.querySelector(".slider") as HTMLElement | null;
    slider?.classList.toggle("is-disabled", isDisabled);
  }

  function updateSliceModeControlStates() {
    const isSliceMode = activeSliceAxis !== null || isMultiSliceMode;

    for (const axis of CROP_AXES) {
      setCropAxisControlsDisabled(axis, activeSliceAxis === axis);
    }

    const opacityRow = document.getElementById("opacity-row") as HTMLElement | null;
    setUiSectionDisabled(opacityRow, isSliceMode);

    const globalOpacitySlider = document.getElementById("global-opacity-slider") as HTMLInputElement | null;
    if (globalOpacitySlider) {
      globalOpacitySlider.disabled = isSliceMode;
    }

    const globalOpacityInput = document.getElementById("global-opacity-input") as HTMLInputElement | null;
    if (globalOpacityInput) {
      globalOpacityInput.disabled = isSliceMode;
    }
  }

  function updateSliceViewCurrentLabel() {
    const currentLabel = document.getElementById("slice-position-readout") as HTMLElement | null;
    if (!currentLabel) {
      return;
    }

    if (isMultiSliceMode) {
      currentLabel.textContent = `X:${sliceIndexByAxis.x} Y:${sliceIndexByAxis.y} Z:${sliceIndexByAxis.z}`;
      return;
    }

    if (!activeSliceAxis) {
      currentLabel.textContent = "";
      return;
    }

    const axisUpper = activeSliceAxis.toUpperCase();
    currentLabel.textContent = `${axisUpper}:${sliceIndexByAxis[activeSliceAxis]}`;
  }

  function updateSingleSliceUI(axis: CropAxis): void {
    const slider = document.getElementById("slice-single-slider") as HTMLInputElement | null;
    if (!slider) {
      return;
    }

    const axisLetter = document.getElementById("slice-single-axis") as HTMLElement | null;
    const axisValue = document.getElementById("slice-single-value") as HTMLElement | null;

    const maxIndex = getAxisMaxSliceIndex(axis);
    const nextValue = clampSliceIndex(axis, sliceIndexByAxis[axis]);
    sliceIndexByAxis[axis] = nextValue;

    axisLetter?.replaceChildren(axis.toUpperCase());
    axisValue?.replaceChildren(String(nextValue));
    slider.min = "0";
    slider.max = `${maxIndex}`;
    slider.value = `${nextValue}`;
  }

  function updateMultiSliceUI(): void {
    for (const axis of CROP_AXES) {
      const sliderEl = document.getElementById(`slice-${axis}-slider`) as HTMLInputElement | null;
      const valueEl = document.getElementById(`slice-${axis}-value`) as HTMLElement | null;
      if (!sliderEl) {
        continue;
      }

      const maxIndex = getAxisMaxSliceIndex(axis);
      const nextValue = clampSliceIndex(axis, sliceIndexByAxis[axis]);
      sliceIndexByAxis[axis] = nextValue;

      valueEl?.replaceChildren(String(nextValue));
      sliderEl.min = "0";
      sliderEl.max = `${maxIndex}`;
      sliderEl.value = `${nextValue}`;
    }
  }

  function updateSliceSelectorUI() {
    const section = document.getElementById("slice-position-section") as HTMLElement | null;
    const divider = document.getElementById("slice-divider") as HTMLElement | null;
    const singleRow = document.getElementById("slice-single-row") as HTMLElement | null;
    const multiRows = document.getElementById("slice-ortho-rows") as HTMLElement | null;

    const isSliceMode = activeSliceAxis !== null || isMultiSliceMode;
    section?.classList.toggle("hidden", !isSliceMode);
    divider?.classList.toggle("hidden", !isSliceMode);

    if (isMultiSliceMode) {
      singleRow?.classList.add("hidden");
      multiRows?.classList.remove("hidden");
      updateMultiSliceUI();
      updateSliceViewCurrentLabel();
      updateSliceModeControlStates();
      for (const axis of CROP_AXES) {
        setSliceIndexForAxis(axis, sliceIndexByAxis[axis]);
      }
      return;
    }

    multiRows?.classList.add("hidden");

    if (!activeSliceAxis) {
      singleRow?.classList.add("hidden");
      updateSliceViewCurrentLabel();
      updateSliceModeControlStates();
      return;
    }

    singleRow?.classList.remove("hidden");
    updateSingleSliceUI(activeSliceAxis);
    updateSliceViewCurrentLabel();
    updateSliceModeControlStates();
  }

  function setActiveSliceMode(mode: CameraMode) {
    isMultiSliceMode = mode === "ORTHO";
    activeSliceAxis = mode === "3D" || isMultiSliceMode ? null : (mode.toLowerCase() as CropAxis);
    updateSliceSelectorUI();
    applyCropRegionFromState();
  }

  function setupSliceSelectorControls() {
    const singleSlider = document.getElementById("slice-single-slider") as HTMLInputElement | null;
    singleSlider?.addEventListener("input", () => {
      if (!activeSliceAxis) {
        return;
      }

      const nextSliceIndex = clampSliceIndex(activeSliceAxis, singleSlider.valueAsNumber);
      sliceIndexByAxis[activeSliceAxis] = nextSliceIndex;
      setSliceIndexForAxis(activeSliceAxis, nextSliceIndex);

      updateSliceSelectorUI();
      applyCropRegionFromState();
    });

    for (const axis of CROP_AXES) {
      const axisSlider = document.getElementById(`slice-${axis}-slider`) as HTMLInputElement | null;
      axisSlider?.addEventListener("input", () => {
        if (!isMultiSliceMode) {
          return;
        }

        const nextSliceIndex = clampSliceIndex(axis, axisSlider.valueAsNumber);
        sliceIndexByAxis[axis] = nextSliceIndex;
        setSliceIndexForAxis(axis, nextSliceIndex);

        updateSliceSelectorUI();
        applyCropRegionFromState();
      });
    }

    updateSliceSelectorUI();
  }

  function resetSliceIndicesForVolume(volume: Volume) {
    for (const axis of CROP_AXES) {
      const axisCount = Math.max(1, Math.floor(volume.imageInfo.volumeSize[axis]));
      const maxIndex = axisCount - 1;
      sliceIndexByAxis[axis] = Math.floor(maxIndex * 0.5);
      sliceMaxIndexByAxis[axis] = maxIndex;
    }
  }

  function applyCropRegionFromState() {
    const xDisplayBounds = getEffectiveAxisCropBounds("x");
    const yDisplayBounds = getEffectiveAxisCropBounds("y");
    const zDisplayBounds = getEffectiveAxisCropBounds("z");

    const xLoadBounds = getEffectiveAxisLoadBounds("x");
    const yLoadBounds = getEffectiveAxisLoadBounds("y");
    const zLoadBounds = getEffectiveAxisLoadBounds("z");

    const displayMatchesLoad =
      xDisplayBounds.min === xLoadBounds.min &&
      xDisplayBounds.max === xLoadBounds.max &&
      yDisplayBounds.min === yLoadBounds.min &&
      yDisplayBounds.max === yLoadBounds.max &&
      zDisplayBounds.min === zLoadBounds.min &&
      zDisplayBounds.max === zLoadBounds.max;

    void getView3D().updateLoadedRegion(
      state.volume,
      xLoadBounds.min,
      xLoadBounds.max,
      yLoadBounds.min,
      yLoadBounds.max,
      zLoadBounds.min,
      zLoadBounds.max
    );

    if (!displayMatchesLoad) {
      getView3D().updateVisibleRegion(
        state.volume,
        xDisplayBounds.min,
        xDisplayBounds.max,
        yDisplayBounds.min,
        yDisplayBounds.max,
        zDisplayBounds.min,
        zDisplayBounds.max
      );
    }

    onCropRegionApplied?.();
  }

  function getCropAxisSize(axis: CropAxis): number {
    const volumeSize = state.volume.imageInfo.volumeSize;
    switch (axis) {
      case "x":
        return Math.max(1, Math.round(volumeSize.x));
      case "y":
        return Math.max(1, Math.round(volumeSize.y));
      case "z":
        return Math.max(1, Math.round(volumeSize.z));
    }
  }

  function getCropAxisBounds(axis: CropAxis): { left: number; right: number } {
    const axisSize = getCropAxisSize(axis);
    const minKey = cropAxisStateKeys[axis].min;
    const maxKey = cropAxisStateKeys[axis].max;
    const minValue = state[minKey] as number;
    const maxValue = state[maxKey] as number;

    const left = Math.max(0, Math.min(axisSize, Math.floor(minValue * axisSize)));
    const right = Math.max(left, Math.min(axisSize, Math.ceil(maxValue * axisSize)));
    return { left, right };
  }

  function syncCropDimensionInputs(axis: CropAxis) {
    const leftInput = document.getElementById(`crop-${axis}-left`) as HTMLInputElement | null;
    const rightInput = document.getElementById(`crop-${axis}-right`) as HTMLInputElement | null;
    if (!leftInput || !rightInput) {
      return;
    }

    const axisSize = getCropAxisSize(axis);
    const { left, right } = getCropAxisBounds(axis);

    leftInput.min = "0";
    rightInput.min = "0";
    leftInput.max = `${axisSize}`;
    rightInput.max = `${axisSize}`;
    leftInput.value = `${left}`;
    rightInput.value = `${right}`;
  }

  function setCropAxisBounds(axis: CropAxis, left: number, right: number) {
    const axisSize = getCropAxisSize(axis);
    const minKey = cropAxisStateKeys[axis].min;
    const maxKey = cropAxisStateKeys[axis].max;
    const safeLeft = Number.isFinite(left) ? left : 0;
    const safeRight = Number.isFinite(right) ? right : axisSize;
    const nextLeft = Math.max(0, Math.min(axisSize, Math.round(safeLeft)));
    const nextRight = Math.max(nextLeft, Math.min(axisSize, Math.round(safeRight)));

    state[minKey] = axisSize > 0 ? nextLeft / axisSize : 0;
    state[maxKey] = axisSize > 0 ? nextRight / axisSize : 1;
  }

  function syncCropInputsFromState() {
    for (const axis of CROP_AXES) {
      const slider = cropSliders[axis];
      const minKey = cropAxisStateKeys[axis].min;
      const maxKey = cropAxisStateKeys[axis].max;
      slider?.set(state[minKey] as number, state[maxKey] as number);
      syncCropDimensionInputs(axis);
    }
  }

  function setupCropControls() {
    for (const axis of CROP_AXES) {
      const leftInput = document.getElementById(`crop-${axis}-left`) as HTMLInputElement | null;
      const rightInput = document.getElementById(`crop-${axis}-right`) as HTMLInputElement | null;
      const sliderHost = document.getElementById(`crop-${axis}-slider`) as HTMLElement | null;

      if (!leftInput || !rightInput || !sliderHost) {
        continue;
      }

      const minKey = cropAxisStateKeys[axis].min;
      const maxKey = cropAxisStateKeys[axis].max;

      const syncAxis = () => {
        cropSliders[axis]?.set(state[minKey] as number, state[maxKey] as number);
        syncCropDimensionInputs(axis);
        applyCropRegionFromState();
      };

      cropSliders[axis] = createDualSlider({
        host: sliderHost,
        min: 0,
        max: 1,
        onChange: (minValue, maxValue) => {
          state[minKey] = minValue;
          state[maxKey] = maxValue;
          syncCropDimensionInputs(axis);
        },
      });

      const onLeftChange = () => {
        const { right } = getCropAxisBounds(axis);
        setCropAxisBounds(axis, leftInput.valueAsNumber, right);
        syncAxis();
      };

      const onRightChange = () => {
        const { left } = getCropAxisBounds(axis);
        setCropAxisBounds(axis, left, rightInput.valueAsNumber);
        syncAxis();
      };

      const selectAll = (event: Event) => {
        const target = event.currentTarget as HTMLInputElement;
        target.select();
      };

      const commitOnEnter = (event: KeyboardEvent, handler: () => void) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        handler();
        (event.currentTarget as HTMLInputElement).blur();
      };

      leftInput.addEventListener("focus", selectAll);
      rightInput.addEventListener("focus", selectAll);
      leftInput.addEventListener("click", selectAll);
      rightInput.addEventListener("click", selectAll);

      leftInput.addEventListener("change", onLeftChange);
      rightInput.addEventListener("change", onRightChange);
      leftInput.addEventListener("keydown", (event) => commitOnEnter(event, onLeftChange));
      rightInput.addEventListener("keydown", (event) => commitOnEnter(event, onRightChange));
    }

    const resetCropBtn = document.getElementById("crop-reset-button") as HTMLButtonElement | null;
    const copyCropBtn = document.getElementById("crop-copy-indeces-button") as HTMLButtonElement | null;

    copyCropBtn?.addEventListener("click", async () => {
      const x = getCropAxisBounds("x");
      const y = getCropAxisBounds("y");
      const z = getCropAxisBounds("z");
      const indexing = `[${z.left}:${z.right}, ${y.left}:${y.right}, ${x.left}:${x.right}]`;
      navigator.clipboard.writeText(indexing);

      const originalLabel = copyCropBtn.textContent || "Copy coordinates";
      copyCropBtn.textContent = `Copied ${indexing}`;
      window.setTimeout(() => {
        copyCropBtn.textContent = originalLabel;
      }, 3000);
    });

    resetCropBtn?.addEventListener("click", () => {
      state.cropXmin = 0;
      state.cropXmax = 1;
      state.cropYmin = 0;
      state.cropYmax = 1;
      state.cropZmin = 0;
      state.cropZmax = 1;

      syncCropInputsFromState();
      applyCropRegionFromState();
    });

    syncCropInputsFromState();
  }

  function updateZSliceUI(volume: Volume) {
    const zSlider = document.getElementById("zSlider") as HTMLInputElement;
    const zInput = document.getElementById("zValue") as HTMLInputElement;

    const oldMax = Number(zSlider.max);
    const oldValue = Number(zSlider.value);

    const totalZSlices = volume.imageInfo.volumeSize.z;
    const newMax = Math.max(0, totalZSlices - 1);
    sliceMaxIndexByAxis.z = newMax;

    zSlider.max = `${newMax}`;
    zInput.max = `${newMax}`;

    const hasValidPreviousSlice = Number.isFinite(oldValue) && Number.isFinite(oldMax) && oldMax >= 0;

    let nextValue = Math.floor(totalZSlices / 2);
    if (hasValidPreviousSlice) {
      const normalized = oldMax > 0 && Number.isFinite(oldValue) ? oldValue / oldMax : 0;
      nextValue = Math.round(normalized * newMax);
    }
    nextValue = Math.max(0, Math.min(newMax, nextValue));

    sliceIndexByAxis.z = nextValue;

    zInput.value = `${nextValue}`;
    zSlider.value = `${nextValue}`;

    goToZSlice(nextValue);
  }

  return {
    applyCropRegionFromState,
    getEffectiveAxisLoadBounds,
    remapSliceIndicesForRescaledVolume,
    resetSliceIndicesForVolume,
    setActiveSliceMode,
    setupCropControls,
    setupSliceSelectorControls,
    syncCropInputsFromState,
    updateSliceSelectorUI,
    updateZSliceUI,
  };
}
