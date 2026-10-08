import { clamp01 } from "../utils/math";

/**
 * Generic two-handle slider over a [min, max] value range.
 *
 * The host element (`.slider` or `.range`) contains two `.slider__thumb` /
 * `.range__thumb` children (in min, max order). Positions are driven through
 * the `--from` / `--to` (fill) and `--pos` (thumb) CSS custom properties so
 * the reference stylesheet controls the look.
 */
export interface DualSlider {
  set(minValue: number, maxValue: number): void;
  destroy(): void;
}

interface DualSliderOptions {
  host: HTMLElement;
  min: number;
  max: number;
  onChange: (minValue: number, maxValue: number) => void;
}

export function createDualSlider(options: DualSliderOptions): DualSlider {
  const { host, min, max, onChange } = options;
  const span = max - min || 1;

  const thumbs = Array.from(host.querySelectorAll<HTMLElement>("[data-handle]"));
  const minThumb = thumbs[0];
  const maxThumb = thumbs[1];

  let valueMin = min;
  let valueMax = max;
  let activeHandle: "min" | "max" | null = null;

  const render = (): void => {
    const pctMin = ((valueMin - min) / span) * 100;
    const pctMax = ((valueMax - min) / span) * 100;
    host.style.setProperty("--from", `${pctMin}%`);
    host.style.setProperty("--to", `${pctMax}%`);
    minThumb?.style.setProperty("--pos", `${pctMin}%`);
    maxThumb?.style.setProperty("--pos", `${pctMax}%`);
  };

  const valueAtClientX = (clientX: number): number | null => {
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    const normalized = clamp01((clientX - rect.left) / rect.width);
    return min + normalized * span;
  };

  const updateFromClientX = (clientX: number, handle: "min" | "max"): void => {
    const value = valueAtClientX(clientX);
    if (value === null) {
      return;
    }
    const nextMin = handle === "min" ? Math.min(value, valueMax) : valueMin;
    const nextMax = handle === "max" ? Math.max(value, valueMin) : valueMax;
    if (nextMin === valueMin && nextMax === valueMax) {
      return;
    }
    valueMin = nextMin;
    valueMax = nextMax;
    render();
    onChange(valueMin, valueMax);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target === minThumb || target === maxThumb) {
      activeHandle = target === minThumb ? "min" : "max";
    } else {
      const value = valueAtClientX(event.clientX);
      if (value === null) {
        return;
      }
      activeHandle = Math.abs(value - valueMin) <= Math.abs(value - valueMax) ? "min" : "max";
    }
    updateFromClientX(event.clientX, activeHandle);
    host.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!activeHandle) {
      return;
    }
    updateFromClientX(event.clientX, activeHandle);
    event.preventDefault();
  };

  const stopDrag = (event: PointerEvent) => {
    if (!activeHandle) {
      return;
    }
    activeHandle = null;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", stopDrag);
  host.addEventListener("pointercancel", stopDrag);

  render();

  return {
    set(nextMin: number, nextMax: number): void {
      valueMin = Math.min(nextMin, nextMax);
      valueMax = Math.max(nextMin, nextMax);
      render();
    },
    destroy(): void {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", stopDrag);
      host.removeEventListener("pointercancel", stopDrag);
    },
  };
}
