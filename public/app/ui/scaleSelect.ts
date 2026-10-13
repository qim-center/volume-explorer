import { Volume } from "../../../src";

interface SetupScaleSelectOptions {
  button: HTMLButtonElement;
  optionsList: HTMLUListElement;
  getVolume: () => Volume;
  applyScaleLevel: (level?: number) => Promise<void>;
  onShowError: (message?: string) => void;
}

export interface ScaleSelectApi {
  rebuild: (volume: Volume) => void;
  refreshLabel: (volume: Volume) => void;
  setSelection: (value: string) => void;
  stopLoading: () => void;
}

export function setupScaleSelect(options: SetupScaleSelectOptions): ScaleSelectApi {
  const { button, optionsList, getVolume, applyScaleLevel, onShowError } = options;

  const isOpen = (): boolean => !optionsList.hidden;

  const close = (): void => {
    optionsList.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    optionsList.hidden = false;
    button.setAttribute("aria-expanded", "true");
  };

  const markSelection = (value: string): void => {
    const items = optionsList.querySelectorAll<HTMLButtonElement>(".select__option");
    for (const item of items) {
      item.setAttribute("aria-selected", String(item.dataset.value === value));
    }
  };

  // volumes that have been fully loaded at least once
  const displayedVolumes = new WeakSet<Volume>();

  const stopLoading = (): void => {
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  };

  // show the spinner only while a displayed volume is loading new data
  const refreshLoading = (volume: Volume): void => {
    if (volume.isLoaded()) {
      displayedVolumes.add(volume);
    }
    const loading = !volume.isLoaded() && displayedVolumes.has(volume);
    button.classList.toggle("is-loading", loading);
    if (loading) {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
  };

  const refreshLabel = (volume: Volume): void => {
    const totalLevels = volume.imageInfo.numMultiscaleLevels;
    const currentLevel = volume.getRequestedLevel() ?? volume.imageInfo.multiscaleLevel;
    const explicit = volume.loadSpecRequired.useExplicitLevel;

    let text = "Auto";
    if (totalLevels > 1) {
      const resolved = `${currentLevel}/${totalLevels - 1}`;
      text = explicit ? `Level ${currentLevel} · ${resolved}` : `Auto · ${resolved}`;
    }
    button.querySelector("#ome-zarr-scale-select-text")?.replaceChildren(text);
    refreshLoading(volume);
  };

  const rebuild = (volume: Volume): void => {
    optionsList.innerHTML = "";

    const totalLevels = volume.imageInfo.numMultiscaleLevels;
    const { useExplicitLevel, multiscaleLevel } = volume.loadSpecRequired;

    const makeOption = (value: string, label: string, disabled = false): HTMLButtonElement => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "select__option";
      option.dataset.value = value;
      option.textContent = label;
      option.disabled = disabled;
      option.addEventListener("click", () => {
        close();
        void select(value);
      });
      optionsList.appendChild(option);
      return option;
    };

    makeOption("auto", "Auto");
    const loadableLevels = volume.getLoadableLevels();
    for (let i = 0; i < totalLevels; i++) {
      makeOption(String(i), loadableLevels[i] ? `Level ${i}` : `Level ${i} (too large)`, !loadableLevels[i]);
    }

    markSelection(useExplicitLevel ? String(Math.min(multiscaleLevel ?? 0, totalLevels - 1)) : "auto");
    refreshLabel(volume);
  };

  // levels that don't fit are disabled in the dropdown, so any level picked here can be loaded
  const select = async (value: string): Promise<void> => {
    const volume = getVolume();
    const level = value === "auto" ? undefined : Number(value);
    if (!volume || Number.isNaN(level)) {
      return;
    }

    onShowError();
    markSelection(value);
    const pending = applyScaleLevel(level);
    refreshLabel(volume);
    try {
      await pending;
    } catch (error) {
      console.error(error);
    }
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isOpen()) {
      close();
    } else {
      open();
    }
  });

  window.addEventListener("click", (event) => {
    if (!isOpen()) {
      return;
    }
    if (optionsList.contains(event.target as Node) || button.contains(event.target as Node)) {
      return;
    }
    close();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      close();
    }
  });

  return {
    rebuild,
    refreshLabel,
    setSelection: (value: string) => markSelection(value),
    stopLoading,
  };
}
