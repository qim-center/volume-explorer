interface PanelSide {
  panel: HTMLElement;
  header: HTMLElement;
  collapseButton: HTMLButtonElement;
  /** chevron path data pointing at the collapsed direction (i.e. "close") */
  openChevronPath: string;
  /** chevron path data pointing at the expanded direction (i.e. "open") */
  collapsedChevronPath: string;
  collapseLabel: string;
  expandLabel: string;
}

interface SetupPanelCollapseOptions {
  left: PanelSide | null;
  right: PanelSide | null;
}

const setChevron = (button: HTMLButtonElement, path: string): void => {
  const pathEl = button.querySelector<SVGPathElement>("svg path");
  if (pathEl) {
    pathEl.setAttribute("d", path);
  }
};

const setupOne = (side: PanelSide): void => {
  const { panel, header, collapseButton, openChevronPath, collapsedChevronPath, collapseLabel, expandLabel } = side;

  const isCollapsed = (): boolean => panel.classList.contains("is-collapsed");

  const sync = (): void => {
    if (isCollapsed()) {
      setChevron(collapseButton, collapsedChevronPath);
      collapseButton.setAttribute("aria-label", expandLabel);
      // the whole tab is one button
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      header.setAttribute("aria-label", expandLabel);
    } else {
      setChevron(collapseButton, openChevronPath);
      collapseButton.setAttribute("aria-label", collapseLabel);
      header.removeAttribute("role");
      header.removeAttribute("tabindex");
      header.removeAttribute("aria-label");
    }
  };

  const toggle = (): void => {
    panel.classList.toggle("is-collapsed");
    sync();
  };

  collapseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });

  header.addEventListener("click", () => {
    if (isCollapsed()) {
      toggle();
    }
  });

  header.addEventListener("keydown", (event) => {
    if (!isCollapsed()) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  sync();
};

export function setupPanelCollapse(options: SetupPanelCollapseOptions): void {
  if (options.left) {
    setupOne(options.left);
  }
  if (options.right) {
    setupOne(options.right);
  }

  // below ~900 px wide: both cards start collapsed (spec §13)
  if (window.innerWidth < 900) {
    if (options.left) {
      options.left.panel.classList.add("is-collapsed");
    }
    if (options.right) {
      options.right.panel.classList.add("is-collapsed");
    }
  }
}
