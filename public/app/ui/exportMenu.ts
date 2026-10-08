interface SetupExportMenuOptions {
  button: HTMLButtonElement;
  menu: HTMLElement;
  scrim: HTMLElement;
  onView3D: () => { capture: (callback: (dataUrl: string) => void) => void } | null;
  onShowNote: (text: string) => void;
}

export function setupExportMenu(options: SetupExportMenuOptions): void {
  const { button, menu, scrim, onView3D, onShowNote } = options;

  const isOpen = (): boolean => !menu.hidden;

  const close = (): void => {
    menu.hidden = true;
    scrim.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    menu.hidden = false;
    scrim.hidden = false;
    button.setAttribute("aria-expanded", "true");
  };

  const toggle = (): void => {
    if (isOpen()) {
      close();
    } else {
      open();
    }
  };

  const runAction = (action: string): void => {
    close();

    if (action === "screenshot") {
      const view3D = onView3D();
      view3D?.capture((dataUrl) => {
        const anchor = document.createElement("a");
        anchor.href = dataUrl;
        anchor.download = "screenshot.png";
        anchor.click();
      });
      return;
    }

    if (action === "cropped-volume") {
      onShowNote("Cropping the volume to a TIFF export is coming soon.");
      return;
    }

    if (action === "copy-view-link") {
      void navigator.clipboard?.writeText(window.location.href);
    }
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });

  scrim.addEventListener("click", close);

  menu.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>(".menu__item");
    if (item?.dataset.action) {
      runAction(item.dataset.action);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      close();
      button.focus();
    }
  });
}
