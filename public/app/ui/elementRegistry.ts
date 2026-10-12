export interface AppUiElements {
  viewerPanel: HTMLElement | null;
  errorNote: HTMLElement | null;
  sourceUrlInput: HTMLInputElement | null;
  sourceForm: HTMLFormElement | null;
  sourceLoadButton: HTMLButtonElement | null;
  omeZarrScaleSelect: HTMLButtonElement | null;
  omeZarrScaleSelectText: HTMLElement | null;
  omeZarrScaleOptions: HTMLUListElement | null;
  exportButton: HTMLButtonElement | null;
  exportMenu: HTMLElement | null;
  menuScrim: HTMLElement | null;
  panelLeft: HTMLElement | null;
  panelLeftHeader: HTMLElement | null;
  panelLeftCollapse: HTMLButtonElement | null;
  panelRight: HTMLElement | null;
  panelRightHeader: HTMLElement | null;
  panelRightCollapse: HTMLButtonElement | null;
  viewSegmented: HTMLElement | null;
  histogramCanvas: HTMLCanvasElement | null;
  histogramMinTag: HTMLElement | null;
  histogramMaxTag: HTMLElement | null;
  colormapChip: HTMLButtonElement | null;
  colormapPicker: HTMLElement | null;
  colormapInvertToggle: HTMLButtonElement | null;
  colormapRange: HTMLElement | null;
  colormapRangeFill: HTMLElement | null;
  colormapRangeValues: HTMLElement | null;
  globalOpacitySlider: HTMLInputElement | null;
  globalOpacityInput: HTMLInputElement | null;
  showBoundingBox: HTMLButtonElement | null;
  backgroundColor: HTMLButtonElement | null;
  backgroundColorInput: HTMLInputElement | null;
  cropHandlesToggle: HTMLButtonElement | null;
  cropCopyIndicesButton: HTMLButtonElement | null;
  cropResetButton: HTMLButtonElement | null;
  volumeLoadingOverlay: HTMLElement | null;
}

export function getAppUiElements(doc: Document = document): AppUiElements {
  const byId = <T extends Element>(id: string): T | null => doc.getElementById(id) as T | null;

  return {
    viewerPanel: byId("viewer-panel"),
    errorNote: byId("error-note"),
    sourceUrlInput: byId("source-url-input"),
    sourceForm: byId("source-form"),
    sourceLoadButton: byId("source-load-button"),
    omeZarrScaleSelect: byId("ome-zarr-scale-select"),
    omeZarrScaleSelectText: byId("ome-zarr-scale-select-text"),
    omeZarrScaleOptions: byId("ome-zarr-scale-options"),
    exportButton: byId("export-button"),
    exportMenu: byId("export-menu"),
    menuScrim: byId("menu-scrim"),
    panelLeft: byId("panel-left"),
    panelLeftHeader: byId("panel-left-header"),
    panelLeftCollapse: byId("panel-left-collapse"),
    panelRight: byId("panel-right"),
    panelRightHeader: byId("panel-right-header"),
    panelRightCollapse: byId("panel-right-collapse"),
    viewSegmented: byId("view-segmented"),
    histogramCanvas: byId("histogram-canvas"),
    histogramMinTag: byId("histogram-min-tag"),
    histogramMaxTag: byId("histogram-max-tag"),
    colormapChip: byId("colormap-chip"),
    colormapPicker: byId("colormap-picker"),
    colormapInvertToggle: byId("colormap-invert-toggle"),
    colormapRange: byId("colormap-range"),
    colormapRangeFill: byId("colormap-range-fill"),
    colormapRangeValues: byId("colormap-range-values"),
    globalOpacitySlider: byId("global-opacity-slider"),
    globalOpacityInput: byId("global-opacity-input"),
    showBoundingBox: byId("showBoundingBox"),
    backgroundColor: byId("backgroundColor"),
    backgroundColorInput: byId("backgroundColor-input"),
    cropHandlesToggle: byId("cropHandlesToggle"),
    cropCopyIndicesButton: byId("crop-copy-indeces-button"),
    cropResetButton: byId("crop-reset-button"),
    volumeLoadingOverlay: byId("volume-loading-overlay"),
  };
}
