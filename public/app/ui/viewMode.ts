import { View3d } from "../../../src";
import { CameraMode } from "../state/stateService";

const MODE_ORDER: CameraMode[] = ["Z", "Y", "X", "ORTHO", "3D"];

interface SetupViewModeOptions {
  segmented: HTMLElement;
  view3D: View3d;
  onModeChange: (mode: CameraMode) => void;
}

export function setupViewMode(options: SetupViewModeOptions): void {
  const { segmented, view3D, onModeChange } = options;
  const buttons = Array.from(segmented.querySelectorAll<HTMLButtonElement>(".segmented__item"));
  const indexByMode = new Map<CameraMode, number>();
  buttons.forEach((button, index) => {
    const mode = button.dataset.mode as CameraMode;
    indexByMode.set(mode, index);
  });

  const setMode = (mode: CameraMode): void => {
    const index = indexByMode.get(mode);
    if (index === undefined) {
      return;
    }
    segmented.style.setProperty("--index", `${index}`);
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String((button.dataset.mode as CameraMode) === mode));
    }
    view3D.setCameraMode(mode);
    onModeChange(mode);
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      setMode(button.dataset.mode as CameraMode);
    });
  }
}

export function getSegmentedIndex(mode: CameraMode): number {
  return MODE_ORDER.indexOf(mode);
}
