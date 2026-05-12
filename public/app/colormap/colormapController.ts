import { Color } from "three";
import { View3d, Volume, ColorizeFeature } from "../../../src";
import { colormaps as colorizercolormaps, features as colorizerfeatures } from "../../colorizer";

const LUT_ENTRIES = 256;
const LUT_ARRAY_LENGTH = LUT_ENTRIES * 4;

interface ColormapControllerState {
  colormap: string;
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
}

export function createColormapController(options: ColormapControllerOptions) {
  const { state, getVolume, getView3D } = options;

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

  const buildColormapPalette = (stops: string[], alphaLut: Uint8Array): Uint8Array => {
    const palette = new Uint8Array(LUT_ARRAY_LENGTH);
    const stopColors = stops.map((stop) => new Color(stop));

    for (let i = 0; i < LUT_ENTRIES; i++) {
      const t = i / (LUT_ENTRIES - 1);
      const [r, g, b] = sampleColormapStops(stopColors, t);
      const offset = i * 4;
      palette[offset] = r;
      palette[offset + 1] = g;
      palette[offset + 2] = b;
      palette[offset + 3] = alphaLut[offset + 3] ?? 255;
    }

    return palette;
  };

  const applyColormapToChannel = (volume: Volume, channelIndex: number): void => {
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

    const palette = buildColormapPalette(colormap.stops, channel.lut.lut);
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

  const syncSelectedColormapSwatch = (colormapPicker: HTMLElement, colormapPreview: HTMLElement | null): void => {
    const swatches = colormapPicker.querySelectorAll<HTMLButtonElement>(".colormap-swatch");
    for (const swatch of swatches) {
      swatch.classList.toggle("is-selected", swatch.dataset.colormapName === state.colormap);
    }

    if (colormapPreview && colorizercolormaps[state.colormap]) {
      colormapPreview.style.background = `linear-gradient(to right, ${colorizercolormaps[state.colormap].stops.join(", ")})`;
      colormapPreview.title = state.colormap;
    }
  };

  const buildColormapPicker = (
    colormapPicker: HTMLElement,
    colormapPreview: HTMLElement | null,
    colormapDropdown: HTMLDetailsElement | null
  ): void => {
    const colormapNames = Object.keys(colorizercolormaps);
    colormapPicker.innerHTML = "";

    if (colormapNames.length === 0) {
      return;
    }

    if (!colorizercolormaps[state.colormap]) {
      state.colormap = colormapNames[0];
    }

    for (const colormapName of colormapNames) {
      const colormap = colorizercolormaps[colormapName];
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "colormap-swatch";
      swatch.dataset.colormapName = colormapName;
      swatch.setAttribute("aria-label", `Select ${colormapName} colormap`);
      swatch.title = colormapName;
      swatch.style.background = `linear-gradient(to right, ${colormap.stops.join(", ")})`;
      swatch.addEventListener("click", () => {
        if (state.colormap === colormapName) {
          colormapDropdown?.removeAttribute("open");
          return;
        }
        state.colormap = colormapName;
        syncSelectedColormapSwatch(colormapPicker, colormapPreview);
        const volume = getVolume();
        const view3D = getView3D();
        applyColormapToVolume(volume);
        view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
        view3D.redraw();
        setColormapInUrl(colormapName);
        colormapDropdown?.removeAttribute("open");
      });
      colormapPicker.appendChild(swatch);
    }

    syncSelectedColormapSwatch(colormapPicker, colormapPreview);
  };

  const setupColorizeControls = (): void => {
    const colorizeButton = document.getElementById("colorize") as HTMLButtonElement;
    const colormapPicker = document.getElementById("colormap-picker") as HTMLElement | null;
    const colormapPreview = document.getElementById("colormap-dropdown-preview") as HTMLElement | null;
    const colormapDropdown = document.getElementById("colormap-dropdown") as HTMLDetailsElement | null;

    if (colormapPicker) {
      buildColormapPicker(colormapPicker, colormapPreview, colormapDropdown);
    }

    const view3D = getView3D();
    const volume = getVolume();

    colorizeButton?.addEventListener("click", () => {
      state.colorizeEnabled = !state.colorizeEnabled;
      view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
    });

    const segChannelInput = document.getElementById("segchannel") as HTMLInputElement;
    segChannelInput?.addEventListener("change", () => {
      const channelIndex = Number(segChannelInput.value);
      state.colorizeChannel = channelIndex;
      view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
    });

    const featureInput = document.getElementById("feature") as HTMLSelectElement;
    featureInput?.addEventListener("change", () => {
      const feature = featureInput.value;
      state.feature = feature;
      view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
    });

    const featureMinInput = document.getElementById("featmin") as HTMLInputElement;
    featureMinInput?.addEventListener("change", () => {
      const featureMin = Number(featureMinInput.value) / 100.0;
      console.log("featureMin: " + featureMin);
      state.featureMin = featureMin;
      view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
    });

    const featureMaxInput = document.getElementById("featmax") as HTMLInputElement;
    featureMaxInput?.addEventListener("change", () => {
      const featureMax = Number(featureMaxInput.value) / 100.0;
      console.log("featureMax: " + featureMax);
      state.featureMax = featureMax;
      view3D.setChannelColorizeFeature(volume, state.colorizeChannel, getStateColorizeFeature());
    });
  };

  return {
    applyColormapToChannel,
    applyColormapToVolume,
    getStateColorizeFeature,
    setColormapInUrl,
    setupColorizeControls,
  };
}
