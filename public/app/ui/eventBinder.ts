import { View3d } from "../../../src";
import { State } from "../../types";
import { densitySliderToView3D } from "../utils/math";
import { hexToRgb01, rgb01ToHex } from "../utils/color";

interface BindPrimaryViewControlsOptions {
  state: State;
  view3D: View3d;
}

interface BindRenderControlsOptions {
  state: State;
  view3D: View3d;
  onSceneChange: (scene: number) => void;
  goToZSlice: (slice: number) => boolean;
  changeRenderMode: (pt: boolean, mp: boolean) => void;
  gammaSliderToImageValues: (sliderValues: [number, number, number]) => [number, number, number];
}

export function bindPrimaryViewControls(options: BindPrimaryViewControlsOptions): void {
  const { state, view3D } = options;

  const rotBtn = document.getElementById("rotBtn");
  rotBtn?.addEventListener("click", () => {
    state.isTurntable = !state.isTurntable;
    view3D.setAutoRotate(state.isTurntable);
  });

  const showBoundsToggle = document.getElementById("showBoundingBox") as HTMLButtonElement | null;
  if (showBoundsToggle) {
    const syncToggle = (): void => {
      showBoundsToggle.setAttribute("aria-checked", String(state.showBoundingBox));
    };
    syncToggle();

    showBoundsToggle.addEventListener("click", () => {
      state.showBoundingBox = !state.showBoundingBox;
      syncToggle();
      view3D.setBoundingBoxColor(state.volume, state.boundingBoxColor);
      view3D.setShowBoundingBox(state.volume, state.showBoundingBox);
    });
  }

  const backgroundSwatch = document.getElementById("backgroundColor") as HTMLButtonElement | null;
  const backgroundPicker = document.getElementById("backgroundColor-input") as HTMLInputElement | null;
  if (backgroundSwatch && backgroundPicker) {
    const applyBackgroundColor = (hex: string): void => {
      state.backgroundColor = hexToRgb01(hex, state.backgroundColor);
      const hexValue = rgb01ToHex(state.backgroundColor);
      backgroundSwatch.style.background = hexValue;
      document.body.style.background = hexValue;
      view3D.setBackgroundColor(state.backgroundColor);
    };

    backgroundSwatch.style.background = rgb01ToHex(state.backgroundColor);
    backgroundPicker.value = rgb01ToHex(state.backgroundColor);

    backgroundSwatch.addEventListener("click", () => {
      // the native popup opens below its input on chromium, so put the (invisible) input just left of the swatch
      const rect = backgroundSwatch.getBoundingClientRect();
      backgroundPicker.style.left = `${rect.left - 250}px`;
      backgroundPicker.style.top = `${rect.top}px`;
      if (backgroundPicker.showPicker) {
        backgroundPicker.showPicker();
      } else {
        backgroundPicker.click();
      }
    });
    backgroundPicker.addEventListener("change", () => {
      applyBackgroundColor(backgroundPicker.value);
    });
  }

  const globalOpacitySlider = document.getElementById("global-opacity-slider") as HTMLInputElement | null;
  const globalOpacityInput = document.getElementById("global-opacity-input") as HTMLInputElement | null;
  if (globalOpacitySlider) {
    const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
    const applyOpacityPercent = (percent: number) => {
      const clampedPercent = clampPercent(percent);
      state.density = clampedPercent;
      globalOpacitySlider.value = `${clampedPercent}`;
      globalOpacitySlider.style.setProperty("--value", `${clampedPercent}`);
      if (globalOpacityInput) {
        globalOpacityInput.value = `${clampedPercent}`;
      }
      view3D.updateDensity(state.volume, densitySliderToView3D(state.density));
    };

    applyOpacityPercent(state.density);

    const onGlobalOpacityInput = () => {
      applyOpacityPercent(globalOpacitySlider.valueAsNumber);
    };

    globalOpacitySlider.addEventListener("input", onGlobalOpacityInput);
    globalOpacitySlider.addEventListener("change", onGlobalOpacityInput);

    if (globalOpacityInput) {
      const onOpacityValueCommit = () => {
        const nextValue = Number.isFinite(globalOpacityInput.valueAsNumber)
          ? globalOpacityInput.valueAsNumber
          : state.density;
        applyOpacityPercent(nextValue);
      };

      globalOpacityInput.addEventListener("change", onOpacityValueCommit);
      globalOpacityInput.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          onOpacityValueCommit();
        }
      });
    }
  }
}

export function bindRenderControls(options: BindRenderControlsOptions): void {
  const { state, view3D, onSceneChange, goToZSlice, changeRenderMode, gammaSliderToImageValues } = options;

  const flipXBtn = document.getElementById("flipXBtn");
  flipXBtn?.addEventListener("click", () => {
    state.flipX *= -1;
    view3D.setFlipVolume(state.volume, state.flipX as -1 | 1, state.flipY, state.flipZ);
  });
  const flipYBtn = document.getElementById("flipYBtn");
  flipYBtn?.addEventListener("click", () => {
    state.flipY *= -1;
    view3D.setFlipVolume(state.volume, state.flipX, state.flipY as -1 | 1, state.flipZ);
  });
  const flipZBtn = document.getElementById("flipZBtn");
  flipZBtn?.addEventListener("click", () => {
    state.flipZ *= -1;
    view3D.setFlipVolume(state.volume, state.flipX, state.flipY, state.flipZ as -1 | 1);
  });

  const sceneInput = document.getElementById("sceneValue") as HTMLInputElement;
  sceneInput?.addEventListener("change", () => {
    onSceneChange(sceneInput.valueAsNumber);
  });

  const zforwardBtn = document.getElementById("zforwardBtn");
  const zbackBtn = document.getElementById("zbackBtn");
  const zSlider = document.getElementById("zSlider") as HTMLInputElement;
  const zInput = document.getElementById("zValue") as HTMLInputElement;
  zforwardBtn?.addEventListener("click", () => {
    goToZSlice(zSlider?.valueAsNumber + 1);
  });
  zbackBtn?.addEventListener("click", () => {
    goToZSlice(zSlider?.valueAsNumber - 1);
  });
  zSlider?.addEventListener("change", () => {
    goToZSlice(zSlider?.valueAsNumber);
  });
  zInput?.addEventListener("change", () => {
    goToZSlice(zInput?.valueAsNumber);
  });

  const alignBtn = document.getElementById("xfBtn");
  alignBtn?.addEventListener("click", () => {
    state.isAligned = !state.isAligned;
    view3D.setVolumeTranslation(state.volume, state.isAligned ? state.volume.getTranslation() : [0, 0, 0]);
    view3D.setVolumeRotation(state.volume, state.isAligned ? state.volume.getRotation() : [0, 0, 0]);
  });
  const resetCamBtn = document.getElementById("resetCamBtn");
  resetCamBtn?.addEventListener("click", () => {
    view3D.resetCamera();
  });
  const counterSpan = document.getElementById("counter");
  if (counterSpan) {
    view3D.setRenderUpdateListener((count) => {
      counterSpan.innerHTML = "" + count;
    });
  }

  const renderModeSelect = document.getElementById("renderMode") as HTMLSelectElement | null;
  renderModeSelect?.addEventListener("change", () => {
    const value = renderModeSelect.value;
    if (value === "PT") {
      if (view3D.hasWebGL2()) {
        changeRenderMode(true, false);
      }
    } else if (value === "MP") {
      changeRenderMode(false, true);
    } else {
      changeRenderMode(false, false);
    }
  });

  const interpolateBtn = document.getElementById("interpolateBtn");
  interpolateBtn?.addEventListener("click", () => {
    state.interpolationActive = !state.interpolationActive;
    view3D.setInterpolationEnabled(state.volume, state.interpolationActive);
  });

  const gammaMin = document.getElementById("gammaMin") as HTMLInputElement;
  const gammaMax = document.getElementById("gammaMax") as HTMLInputElement;
  const gammaScale = document.getElementById("gammaScale") as HTMLInputElement;
  const applyGamma = () => {
    const g = gammaSliderToImageValues([gammaMin.valueAsNumber, gammaScale.valueAsNumber, gammaMax.valueAsNumber]);
    view3D.setGamma(state.volume, g[0], g[1], g[2]);
  };
  gammaMin?.addEventListener("change", applyGamma);
  gammaMin?.addEventListener("input", applyGamma);
  gammaMax?.addEventListener("change", applyGamma);
  gammaMax?.addEventListener("input", applyGamma);
  gammaScale?.addEventListener("change", applyGamma);
  gammaScale?.addEventListener("input", applyGamma);
}
