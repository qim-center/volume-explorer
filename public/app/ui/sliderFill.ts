const FILLABLE_SELECTOR = 'input[type="range"]:not(.crop-handle)';

export function syncRangeFill(el: HTMLInputElement): void {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const value = Number(el.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const clamped = Math.max(0, Math.min(100, percent));
  if (el.style.getPropertyValue("--value") !== `${clamped}`) {
    el.style.setProperty("--value", `${clamped}`);
  }
}

export function setupRangeFillSync(): void {
  const sliders = Array.from(document.querySelectorAll<HTMLInputElement>(FILLABLE_SELECTOR));
  const last = new Map<HTMLInputElement, string>();
  sliders.forEach((slider) => {
    slider.addEventListener("input", () => syncRangeFill(slider));
    slider.addEventListener("change", () => syncRangeFill(slider));
  });

  const tick = () => {
    sliders.forEach((slider) => {
      const key = `${slider.value}|${slider.min}|${slider.max}`;
      if (last.get(slider) !== key) {
        last.set(slider, key);
        syncRangeFill(slider);
      }
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
