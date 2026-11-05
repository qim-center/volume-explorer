import { View3d } from "../../../src";
import { State } from "../../types";

const PLAYBACK_INTERVAL = 200;

interface TimeControllerOptions {
  state: State;
  getView3D: () => View3d;
  setSyncMultichannelLoading: (sync: boolean) => void;
}

export function createTimeController(options: TimeControllerOptions) {
  const { state, getView3D, setSyncMultichannelLoading } = options;

  const getNumberOfTimesteps = (): number => state.totalFrames || state.volume?.imageInfo.times || 1;

  function updateTimeUI() {
    const maxFrame = Math.max(0, getNumberOfTimesteps() - 1);
    const isTimeSeries = maxFrame > 0;

    document.getElementById("time-section")?.toggleAttribute("hidden", !isTimeSeries);
    document.getElementById("time-divider")?.toggleAttribute("hidden", !isTimeSeries);

    const slider = document.getElementById("time-slider") as HTMLInputElement | null;
    if (slider) {
      slider.max = `${maxFrame}`;
      slider.value = `${state.currentFrame}`;
    }
    document.getElementById("time-readout")?.replaceChildren(`T:${state.currentFrame}/${maxFrame}`);

    const playBtn = document.getElementById("time-play") as HTMLButtonElement | null;
    if (playBtn) {
      playBtn.setAttribute("aria-label", state.isPlaying ? "Pause time series" : "Play time series");
      playBtn.setAttribute("aria-pressed", String(state.isPlaying));
    }
  }

  function stopPlayback() {
    if (!state.isPlaying) {
      return;
    }
    window.clearTimeout(state.timerId);
    state.isPlaying = false;
    setSyncMultichannelLoading(false);
    void getView3D().setTime(state.volume, state.currentFrame);
    updateTimeUI();
  }

  function startPlayback() {
    window.clearTimeout(state.timerId);
    setSyncMultichannelLoading(true);
    state.isPlaying = true;
    const volume = state.volume;

    const loadNextFrame = () => {
      state.lastFrameTime = Date.now();
      const nextFrame = (state.currentFrame + 1) % getNumberOfTimesteps();

      void getView3D().setTime(volume, nextFrame, (vol) => {
        if (!vol.isLoaded() || !state.isPlaying || vol !== state.volume) {
          return;
        }
        state.currentFrame = nextFrame;
        updateTimeUI();
        const timeLoading = Date.now() - state.lastFrameTime;
        state.timerId = window.setTimeout(loadNextFrame, PLAYBACK_INTERVAL - timeLoading);
      });
    };

    updateTimeUI();
    loadNextFrame();
  }

  function goToFrame(targetFrame: number): boolean {
    if (!Number.isInteger(targetFrame) || targetFrame < 0 || targetFrame > getNumberOfTimesteps() - 1) {
      return false;
    }
    stopPlayback();
    if (targetFrame !== state.currentFrame) {
      state.currentFrame = targetFrame;
      void getView3D().setTime(state.volume, targetFrame);
    }
    updateTimeUI();
    return true;
  }

  function resetForVolume() {
    stopPlayback();
    state.currentFrame = 0;
    updateTimeUI();
  }

  function setupTimeControls() {
    const slider = document.getElementById("time-slider") as HTMLInputElement | null;
    slider?.addEventListener("input", () => {
      goToFrame(slider.valueAsNumber);
    });

    document.getElementById("time-play")?.addEventListener("click", () => {
      if (state.isPlaying) {
        stopPlayback();
      } else {
        startPlayback();
      }
    });
    document.getElementById("time-back")?.addEventListener("click", () => {
      goToFrame(state.currentFrame - 1);
    });
    document.getElementById("time-forward")?.addEventListener("click", () => {
      goToFrame(state.currentFrame + 1);
    });

    updateTimeUI();
  }

  return {
    getNumberOfTimesteps,
    goToFrame,
    resetForVolume,
    setupTimeControls,
    stopPlayback,
    updateTimeUI,
  };
}
