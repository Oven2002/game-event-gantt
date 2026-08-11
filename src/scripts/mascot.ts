import type { TimelinePayload } from "../lib/types";
import { resolveAssetUrl } from "../lib/asset-url";

declare global {
  interface Window {
    initWidget?: (config: Record<string, unknown>) => void;
  }
}

const assetUrl = (path: string) => resolveAssetUrl(import.meta.env.BASE_URL, path, window.location.origin);

function ongoingBannerCount(): number {
  const data = document.querySelector<HTMLScriptElement>("#timeline-data")?.textContent;
  if (!data) return 0;
  const payload = JSON.parse(data) as TimelinePayload;
  const now = Date.now();
  return payload.groups.reduce((count, group) => count + group.events.filter((event) =>
    event.typeId === "banner" && event.start <= now && (event.end ?? event.start) >= now
  ).length, 0);
}

function makeAccessible(): () => void {
  if (localStorage.getItem("waifu-disabled") === "true") return () => {};

  const labels: Record<string, string> = {
    "switch-model": "切换看板娘",
    info: "查看 Live2D 组件信息",
    quit: "隐藏看板娘",
  };
  let observer: MutationObserver;
  let observing = false;
  let waitingToggle: HTMLElement | null = null;

  const stopObserving = () => {
    observer.disconnect();
    observing = false;
  };
  const startObserving = () => {
    if (observing) return;
    observer.observe(document.body, { childList: true, subtree: true });
    observing = true;
  };
  const resumeWhenOpened = () => {
    waitingToggle = null;
    startObserving();
    enhanceControls();
  };
  const stop = () => {
    stopObserving();
    waitingToggle?.removeEventListener("click", resumeWhenOpened);
    waitingToggle = null;
  };
  const enhanceControls = () => {
    const toggle = document.querySelector<HTMLElement>("#waifu-toggle");
    if (toggle && !toggle.hasAttribute("role")) {
      toggle.setAttribute("role", "button");
      toggle.tabIndex = 0;
      toggle.setAttribute("aria-label", "显示看板娘");
      toggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle.click();
        }
      });
    }
    Object.entries(labels).forEach(([tool, label]) => {
      const element = document.querySelector<HTMLElement>(`#waifu-tool-${tool}`);
      if (!element || element.hasAttribute("role")) return;
      element.setAttribute("role", "button");
      element.tabIndex = 0;
      element.setAttribute("aria-label", label);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          element.click();
        }
      });
    });
    const toolsReady = Object.keys(labels).every((tool) =>
      document.querySelector(`#waifu-tool-${tool}[role="button"]`)
    );
    if (toggle?.getAttribute("role") === "button" && toolsReady) {
      stop();
    } else if (toggle?.hasAttribute("first-time") && waitingToggle !== toggle) {
      stopObserving();
      waitingToggle?.removeEventListener("click", resumeWhenOpened);
      waitingToggle = toggle;
      toggle.addEventListener("click", resumeWhenOpened, { once: true });
    }
  };
  observer = new MutationObserver(enhanceControls);
  startObserving();
  enhanceControls();
  return stop;
}

async function initializeMascot(): Promise<void> {
  let stopAccessibilityObserver = () => {};
  const refreshAccessibility = () => {
    stopAccessibilityObserver();
    stopAccessibilityObserver = makeAccessible();
  };
  window.addEventListener("live2d:widget-ready", refreshAccessibility);
  try {
    const response = await fetch(assetUrl("vendor/live2d-config.json"));
    if (!response.ok) throw new Error(`配置加载失败：${response.status}`);
    const config = await response.json() as Record<string, any>;
    const bannerCount = ongoingBannerCount();
    config.message.tapBody = config.message.tapBody.map((text: string) =>
      text.replace("{{ongoingBanners}}", String(bannerCount))
    );
    const modelPaths: Record<string, string> = {
      "Mao Niziiro": "vendor/live2d-models/mao/mao_pro.model3.json",
      Hibiki: "vendor/live2d-models/hibiki/hibiki.model3.json",
    };
    config.models.forEach((model: { name: string; paths: string[] }) => {
      const path = modelPaths[model.name];
      if (!path) throw new Error(`未知看板娘模型：${model.name}`);
      model.paths[0] = assetUrl(path);
    });
    if (typeof window.initWidget !== "function") throw new Error("Live2D 组件未正确初始化");
    stopAccessibilityObserver = makeAccessible();
    window.initWidget({
      waifuData: config,
      cubism5Path: assetUrl("vendor/live2d-runtime/live2dcubismcore.min.js"),
      tools: ["switch-model", "info", "quit"],
      drag: true,
      showToggleAfterQuit: true,
      logLevel: "warn",
    });
  } catch (error) {
    stopAccessibilityObserver();
    window.removeEventListener("live2d:widget-ready", refreshAccessibility);
    console.warn("看板娘加载失败，时间表功能不受影响。", error);
    document.querySelector("#waifu")?.remove();
    document.querySelector("#waifu-toggle")?.remove();
  }
}

const schedule = window.requestIdleCallback
  ? (callback: () => void) => window.requestIdleCallback(callback, { timeout: 2500 })
  : (callback: () => void) => window.setTimeout(callback, 1200);

schedule(() => void initializeMascot());
