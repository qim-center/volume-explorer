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

const ANIM_MS = 220;

const setChevron = (button: HTMLButtonElement, path: string): void => {
  const pathEl = button.querySelector<SVGPathElement>("svg path");
  if (pathEl) {
    pathEl.setAttribute("d", path);
  }
};

const setupOne = (side: PanelSide): void => {
  const { panel, header, collapseButton, openChevronPath, collapsedChevronPath, collapseLabel, expandLabel } = side;

  let animating = false;
  const isCollapsed = (): boolean => panel.classList.contains("is-collapsed");

  const sync = (collapsedOverride?: boolean): void => {
    // during the collapse animation the class is applied only at the end, so the chevron must
    // follow the target state explicitly to flip immediately
    if (collapsedOverride ?? isCollapsed()) {
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

  const finishAnimation = (): void => {
    panel.classList.remove("is-animating");
    panel.style.width = "";
    panel.style.height = "";
    animating = false;
  };

  // read a dimension in the opposite state without letting the user see the swap
  const measureInState = (collapsed: boolean): { width: number; height: number } => {
    const wasCollapsed = isCollapsed();
    panel.classList.toggle("is-collapsed", collapsed);
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    panel.classList.toggle("is-collapsed", wasCollapsed);
    return { width, height };
  };

  const toggle = (): void => {
    if (animating) {
      return;
    }
    animating = true;
    const collapsing = !isCollapsed();

    const start = { width: panel.offsetWidth, height: panel.offsetHeight };
    const end = collapsing
      ? { ...measureInState(true), height: header.offsetHeight }
      : measureInState(false);

    // collapse: keep the body rendered (it gets clipped while the frame shrinks) and only add
    // .is-collapsed at the end; expand: remove it now so the body is revealed while growing
    if (!collapsing) {
      panel.classList.remove("is-collapsed");
    }
    sync(collapsing);

    panel.style.width = `${start.width}px`;
    panel.style.height = `${start.height}px`;
    panel.classList.add("is-animating");
    void panel.offsetWidth; // commit the start size before the transition

    panel.style.width = `${end.width}px`;
    panel.style.height = `${end.height}px`;

    window.setTimeout(() => {
      panel.classList.toggle("is-collapsed", collapsing);
      finishAnimation();
    }, ANIM_MS);
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
