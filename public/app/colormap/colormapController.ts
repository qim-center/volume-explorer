import { Color } from "three";
import { View3d, Volume, ColorizeFeature, LUT_ENTRIES } from "../../../src";
import { colormaps as colorizercolormaps, features as colorizerfeatures } from "../../colorizer";
import { createDualSlider, DualSlider } from "../ui/dualSlider";

const LUT_ARRAY_LENGTH = LUT_ENTRIES * 4;

interface ColormapControllerState {
  colormap: string;
  colormapMin: number;
  colormapMax: number;
  colormapInverted: boolean;
  colorizeEnabled: boolean;
  colorizeChannel: number;
  feature: string;
  featureMin: number;
  featureMax: number;
  channelGui: Array<{ colorizeEnabled: boolean; colorizeAlpha: number }>;
}

interface ColormapControllerOptions {
  state: ColormapControllerState;
  getVolume: () => Volume;
  getView3D: () => View3d;
  getColormapRange?: () => { minBin: number; maxBin: number };
  onColormapChange?: () => void;
}

export function createColormapController(options: ColormapControllerOptions) {
  const { state, getVolume, getView3D, getColormapRange, onColormapChange } = options;

  const sampleColormapStops = (stopColors: Color[], t: number): [number, number, number] => {
    if (stopColors.length === 0) {
      return [255, 255, 255];
    }
    if (stopColors.length === 1) {
      const only = stopColors[0];
      return [Math.round(only.r * 255), Math.round(only.g * 255), Math.round(only.b * 255)];
    }

    const clamped = Math.min(1, Math.max(0, t));
    const scaled = clamped * (stopColors.length - 1);
    const index = Math.min(stopColors.length - 2, Math.floor(scaled));
    const frac = scaled - index;
    const a = stopColors[index];
    const b = stopColors[index + 1];
    const r = a.r + (b.r - a.r) * frac;
    const g = a.g + (b.g - a.g) * frac;
    const bcol = a.b + (b.b - a.b) * frac;
    return [Math.round(r * 255), Math.round(g * 255), Math.round(bcol * 255)];
  };

  const buildColormapPalette = (
    stops: string[],
    alphaLut: Uint8Array,
    minBin?: number,
    maxBin?: number,
    inverted?: boolean
  ): Uint8Array => {
    const palette = new Uint8Array(LUT_ARRAY_LENGTH);
    const stopColors = stops.map((stop) => new Color(stop));
    const lo = minBin ?? 0;
    const hi = maxBin ?? LUT_ENTRIES - 1;
    const range = hi - lo || 1;

    for (let i = 0; i < LUT_ENTRIES; i++) {
      const t = (i - lo) / range;
      const [r, g, b] = sampleColormapStops(stopColors, inverted ? 1 - t : t);
      const offset = i * 4;
      palette[offset] = r;
      palette[offset + 1] = g;
      palette[offset + 2] = b;
      palette[offset + 3] = alphaLut[offset + 3] ?? 255;
    }

    return palette;
  };

  const applyColormapToChannel = (volume: Volume, channelIndex: number, minBin?: number, maxBin?: number): void => {
    if (!volume) {
      return;
    }
    const channel = volume.getChannel(channelIndex);
    if (!channel || !channel.loaded) {
      return;
    }

    const channelGui = state.channelGui[channelIndex];
    const isLabelColorizeActive = !!channelGui?.colorizeEnabled && channelGui.colorizeAlpha > 0;
    if (isLabelColorizeActive) {
      return;
    }

    const colormap = colorizercolormaps[state.colormap];
    if (!colormap || !colormap.stops || colormap.stops.length === 0) {
      volume.setColorPaletteAlpha(channelIndex, 0);
      return;
    }

    const range = getColormapRange?.();
    const palette = buildColormapPalette(
      colormap.stops,
      channel.lut.lut,
      minBin ?? range?.minBin,
      maxBin ?? range?.maxBin,
      state.colormapInverted
    );
    volume.setColorPalette(channelIndex, palette);
    volume.setColorPaletteAlpha(channelIndex, 1);
  };

  const applyColormapToVolume = (volume: Volume): void => {
    const view3D = getView3D();
    if (!volume || !view3D) {
      return;
    }
    for (let i = 0; i < volume.numChannels; i++) {
      applyColormapToChannel(volume, i);
    }
    view3D.updateLuts(volume);
  };

  const getStateColorizeFeature = (): ColorizeFeature | null => {
    if (state.colorizeEnabled) {
      const feature = colorizerfeatures[state.feature];
      const colormap = colorizercolormaps[state.colormap].tex;
      return {
        idsToFeatureValue: feature.featureTex,
        featureValueToColor: colormap,
        outlierData: feature.outlierData,
        inRangeIds: feature.inRangeIds,
        featureMin: state.featureMin,
        featureMax: state.featureMax,
        outlineColor: new Color(0xffffff),
        outlineAlpha: 1.0,
        outlierColor: new Color(0x444444),
        outOfRangeColor: new Color(0x444444),
        outlierDrawMode: 0,
        outOfRangeDrawMode: 0,
        hideOutOfRange: false,
        frameToGlobalIdLookup: new Map(),
        useRepeatingColor: false,
      };
    } else {
      return null;
    }
  };

  const setColormapInUrl = (colormap: string): void => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (colormap) {
        params.set("colormap", colormap);
      } else {
        params.delete("colormap");
      }
      window.history.replaceState(null, "", `?${params.toString()}`);
    } catch (e) {
      console.log(e);
    }
  };

  const getOrderedColormapStops = (colormapName: string): string[] | null => {
    const colormap = colorizercolormaps[colormapName];
    if (!colormap || !colormap.stops) {
      return null;
    }
    return state.colormapInverted ? [...colormap.stops].reverse() : colormap.stops;
  };

  const syncColormapChip = (): void => {
    const chip = document.getElementById("colormap-chip") as HTMLButtonElement | null;
    const stops = getOrderedColormapStops(state.colormap);
    if (chip && stops) {
      chip.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
      chip.title = state.colormap;
    }
  };

  const syncColormapPickerSelection = (picker: HTMLElement): void => {
    const options = picker.querySelectorAll<HTMLButtonElement>(".colormap-picker__option");
    for (const option of options) {
      option.setAttribute("aria-selected", String(option.dataset.colormapName === state.colormap));
    }
  };

  const buildColormapPicker = (picker: HTMLElement, chip: HTMLButtonElement | null): { closePicker: () => void } => {
    const closePicker = (): void => {
      picker.hidden = true;
      chip?.setAttribute("aria-expanded", "false");
    };

    const colormapNames = Object.keys(colorizercolormaps);
    picker.innerHTML = "";

    if (!colorizercolormaps[state.colormap]) {
      state.colormap = colormapNames[0] ?? "viridis";
    }

    for (const colormapName of colormapNames) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "colormap-picker__option";
      option.dataset.colormapName = colormapName;
      option.setAttribute("aria-label", `Select ${colormapName} colormap`);
      option.title = colormapName;
      const stops = getOrderedColormapStops(colormapName);
      if (stops) {
        option.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
      }
      option.addEventListener("click", () => {
        closePicker();
        if (state.colormap === colormapName) {
          return;
        }
        state.colormap = colormapName;
        syncColormapChip();
        const volume = getVolume();
        const view3D = getView3D();
        applyColormapToVolume(volume);
        onColormapChange?.();
        view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
        view3D.redraw();
        setColormapInUrl(colormapName);
      });
      picker.appendChild(option);
    }

    syncColormapPickerSelection(picker);
    return { closePicker };
  };

  let colormapRangeSlider: DualSlider | null = null;

  const syncColormapRangeUI = (): void => {
    colormapRangeSlider?.set(state.colormapMin, state.colormapMax);
    const values = document.getElementById("colormap-range-values") as HTMLElement | null;
    values?.replaceChildren(`${Math.round(state.colormapMin)} – ${Math.round(state.colormapMax)}`);
  };

  const applyColormapRange = (minValue: number, maxValue: number): void => {
    state.colormapMin = Math.round(minValue);
    state.colormapMax = Math.round(maxValue);
    syncColormapRangeUI();
    const volume = getVolume();
    if (volume) {
      applyColormapToVolume(volume);
    }
    onColormapChange?.();
  };

  const setupColormapRangeControls = (): void => {
    const rangeHost = document.getElementById("colormap-range") as HTMLElement | null;
    if (!rangeHost) {
      return;
    }

    colormapRangeSlider = createDualSlider({
      host: rangeHost,
      min: 0,
      max: 255,
      onChange: (minValue, maxValue) => {
        state.colormapMin = Math.round(minValue);
        state.colormapMax = Math.round(maxValue);
        const values = document.getElementById("colormap-range-values") as HTMLElement | null;
        values?.replaceChildren(`${state.colormapMin} – ${state.colormapMax}`);
      },
    });

    rangeHost.addEventListener("pointerup", () => {
      applyColormapRange(state.colormapMin, state.colormapMax);
    });
    rangeHost.addEventListener("pointercancel", () => {
      applyColormapRange(state.colormapMin, state.colormapMax);
    });

    syncColormapRangeUI();
  };

  const setupColormapChipControl = (): void => {
    const chip = document.getElementById("colormap-chip") as HTMLButtonElement | null;
    const picker = document.getElementById("colormap-picker") as HTMLElement | null;

    if (!chip || !picker) {
      return;
    }

    const { closePicker } = buildColormapPicker(picker, chip);

    syncColormapChip();

    chip.addEventListener("click", () => {
      const isExpanded = chip.getAttribute("aria-expanded") === "true";
      if (isExpanded) {
        closePicker();
        return;
      }
      picker.hidden = false;
      chip.setAttribute("aria-expanded", "true");
      syncColormapPickerSelection(picker);

      const dismiss = (event: Event) => {
        if (picker.contains(event.target as Node) || chip.contains(event.target as Node)) {
          return;
        }
        closePicker();
        window.removeEventListener("pointerdown", dismiss, true);
      };
      window.addEventListener("pointerdown", dismiss, true);
    });
  };

  const setupColormapInvertControl = (): void => {
    const invertToggle = document.getElementById("colormap-invert-toggle") as HTMLButtonElement | null;
    if (!invertToggle) {
      return;
    }

    const syncInvertButton = () => {
      invertToggle.classList.toggle("active", state.colormapInverted);
      invertToggle.setAttribute("aria-pressed", String(state.colormapInverted));
    };
    syncInvertButton();

    invertToggle.addEventListener("click", () => {
      state.colormapInverted = !state.colormapInverted;
      syncInvertButton();
      syncColormapChip();

      const picker = document.getElementById("colormap-picker") as HTMLElement | null;
      if (picker) {
        syncColormapPickerSelection(picker);
        const options = picker.querySelectorAll<HTMLButtonElement>(".colormap-picker__option");
        for (const option of options) {
          const stops = getOrderedColormapStops(option.dataset.colormapName ?? "");
          if (stops) {
            option.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
          }
        }
      }

      const volume = getVolume();
      if (volume) {
        applyColormapToVolume(volume);
      }
      onColormapChange?.();
    });
  };

  const setupColorizeControls = (): void => {
    const view3D = getView3D();

    const colorizeButton = document.getElementById("colorize") as HTMLButtonElement;
    colorizeButton?.addEventListener("click", () => {
      state.colorizeEnabled = !state.colorizeEnabled;
      view3D.setChannelColorizeFeature(getVolume(), state.colorizeChannel, getStateColorizeFeature());
    });

    const segChannelInput = document.getElementById("segchannel") as HTMLInputElement;
    segChannelInput?.addEventListener("change", () => {
      const channelIndex = Number(segChannelInput.value);
      state.colorizeChannel = channelIndex;
      view3D.setChannelColorizeFeature(getVolume(), state.colorizeChannel, getStateColorizeFeature());
    });

    const featureInput = document.getElementById("feature") as HTMLSelectElement;
    featureInput?.addEventListener("change", () => {
      const feature = featureInput.value;
      state.feature = feature;
      view3D.setChannelColorizeFeature(getVolume(), state.colorizeChannel, getStateColorizeFeature());
    });

    const featureMinInput = document.getElementById("featmin") as HTMLInputElement;
    featureMinInput?.addEventListener("change", () => {
      const featureMin = Number(featureMinInput.value) / 100.0;
      state.featureMin = featureMin;
      view3D.setChannelColorizeFeature(getVolume(), state.colorizeChannel, getStateColorizeFeature());
    });

    const featureMaxInput = document.getElementById("featmax") as HTMLInputElement;
    featureMaxInput?.addEventListener("change", () => {
      const featureMax = Number(featureMaxInput.value) / 100.0;
      state.featureMax = featureMax;
      view3D.setChannelColorizeFeature(getVolume(), state.colorizeChannel, getStateColorizeFeature());
    });
  };

  return {
    applyColormapToChannel,
    applyColormapToVolume,
    getStateColorizeFeature,
    setColormapInUrl,
    getColormapStops: (): string[] | null => getOrderedColormapStops(state.colormap),
    setupColorizeControls,
    setupColormapRangeControls,
    setupColormapChipControl,
    setupColormapInvertControl,
  };
}
