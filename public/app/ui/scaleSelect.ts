import { Volume } from "../../../src";

interface SetupScaleSelectOptions {
  button: HTMLButtonElement;
  optionsList: HTMLUListElement;
  getVolume: () => Volume;
  applyScaleLevel: (level?: number) => Promise<void>;
  canLevelFitInAtlas: (level: number) => boolean;
  onShowError: (message?: string) => void;
}

export interface ScaleSelectApi {
  rebuild: (volume: Volume) => void;
  refreshLabel: (volume: Volume) => void;
  setSelection: (value: string) => void;
}

export function setupScaleSelect(options: SetupScaleSelectOptions): ScaleSelectApi {
  const { button, optionsList, getVolume, applyScaleLevel, canLevelFitInAtlas, onShowError } = options;

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

  const refreshLabel = (volume: Volume): void => {
    const totalLevels = volume.imageInfo.numMultiscaleLevels;
    const currentLevel = volume.imageInfo.multiscaleLevel;
    const explicit = volume.loadSpec.useExplicitLevel;

    let text = "Auto";
    if (totalLevels > 1) {
      const resolved = `Level ${currentLevel}/${totalLevels - 1}`;
      text = explicit ? `Level ${currentLevel} · ${resolved}` : `Auto · ${resolved}`;
    }
    button.querySelector("#ome-zarr-scale-select-text")?.replaceChildren(text);
  };

  const rebuild = (volume: Volume): void => {
    optionsList.innerHTML = "";

    const totalLevels = volume.imageInfo.numMultiscaleLevels;
    const currentLevel = volume.imageInfo.multiscaleLevel;
    const explicit = volume.loadSpec.useExplicitLevel;

    const makeOption = (value: string, label: string): HTMLButtonElement => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "select__option";
      option.dataset.value = value;
      option.textContent = label;
      option.addEventListener("click", () => {
        close();
        void select(value);
      });
      optionsList.appendChild(option);
      return option;
    };

    makeOption("auto", "Auto");
    for (let i = 0; i < totalLevels; i++) {
      makeOption(String(i), `Level ${i}`);
    }

    markSelection(explicit ? String(currentLevel) : "auto");
    refreshLabel(volume);
  };

  const select = async (value: string): Promise<void> => {
    const volume = getVolume();
    if (!volume) {
      return;
    }

    onShowError();

    if (value === "auto") {
      try {
        await applyScaleLevel();
      } catch {
        onShowError("Selected scale level is too large for this device. Reverted to Auto.");
      }
      return;
    }

    const level = Number(value);
    if (Number.isNaN(level)) {
      return;
    }

    if (!canLevelFitInAtlas(level)) {
      onShowError("Selected scale level is too large for this device. Reverted to Auto.");
      markSelection("auto");
      refreshLabel(volume);
      await applyScaleLevel();
      return;
    }

    try {
      await applyScaleLevel(level);
    } catch {
      onShowError("Selected scale level is too large for this device. Reverted to Auto.");
      markSelection("auto");
      refreshLabel(volume);
      await applyScaleLevel();
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
  };
}
