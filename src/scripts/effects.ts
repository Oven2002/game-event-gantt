import { EFFECTS_PREFERENCES_KEY, parseEffectsPreferences } from "../lib/effects-preferences";

interface Petal {
  x: number;
  y: number;
  size: number;
  speed: number;
  drift: number;
  rotation: number;
  spin: number;
  opacity: number;
}

const canvas = document.querySelector<HTMLCanvasElement>("#sakura-canvas");
const toggle = document.querySelector<HTMLButtonElement>("[data-effect-toggle]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const preferences = loadPreferences();
let context: CanvasRenderingContext2D | null = null;
let petals: Petal[] = [];
let frame: number | undefined;
let width = 0;
let height = 0;
let dpr = 1;
let resizeTimer: number | undefined;
const petalSprites = new Map<number, { canvas: HTMLCanvasElement; cssSize: number }>();

function loadPreferences() {
  try {
    return parseEffectsPreferences(localStorage.getItem(EFFECTS_PREFERENCES_KEY), !reducedMotion.matches);
  } catch {
    return parseEffectsPreferences(null, !reducedMotion.matches);
  }
}

function savePreferences(): void {
  try {
    localStorage.setItem(EFFECTS_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Effects remain optional when storage is unavailable.
  }
}

// 与看板娘组件（vendor/live2d-widget）的隐式 localStorage 契约：
// widget 读到 24 小时内的 waifu-display 时间戳时不会自动显示看板娘，只保留
// 右下角的唤回按钮（见 vendor/live2d-widget/src/widget.ts 的 initWidget 逻辑）。
// 因此「隐藏」= 写入当前时间戳，「显示」= 移除两个键让组件恢复自动加载。
// 改动前请先核对 widget.ts 中的读取条件，两边要保持一致。
function syncMascotPreference(): void {
  try {
    if (preferences.mascotVisible) {
      localStorage.removeItem("waifu-display");
      localStorage.removeItem("waifu-disabled");
    } else {
      localStorage.setItem("waifu-display", String(Date.now()));
    }
  } catch {
    // The widget still works without persistence.
  }
}

function randomPetal(startAbove = false): Petal {
  return {
    x: Math.random() * width,
    y: startAbove ? -20 - Math.random() * height * .3 : Math.random() * height,
    size: 5 + Math.random() * 7,
    speed: .45 + Math.random() * .8,
    drift: -.3 + Math.random() * .75,
    rotation: Math.random() * Math.PI * 2,
    spin: -.018 + Math.random() * .036,
    opacity: .42 + Math.random() * .42,
  };
}

function resize(): void {
  if (!canvas) return;
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context = canvas.getContext("2d");
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  petalSprites.clear();
  const targetCount = width <= 760 ? 10 : 20;
  petals = Array.from({ length: targetCount }, (_, index) => petals[index] ?? randomPetal());
}

function getPetalSprite(size: number): { canvas: HTMLCanvasElement; cssSize: number } {
  const key = Math.round(size * 10) / 10;
  const cssSize = key * 2.4 + 4;
  const existing = petalSprites.get(key);
  if (existing) return existing;

  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(cssSize * dpr);
  sprite.height = Math.ceil(cssSize * dpr);
  const spriteContext = sprite.getContext("2d");
  if (spriteContext) {
    spriteContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    const center = cssSize / 2;
    const gradient = spriteContext.createLinearGradient(center - key, center - key, center + key, center + key);
    gradient.addColorStop(0, "#fff3fa");
    gradient.addColorStop(.45, "#ffacd2");
    gradient.addColorStop(1, "#d88cff");
    spriteContext.fillStyle = gradient;
    spriteContext.beginPath();
    spriteContext.moveTo(center, center);
    spriteContext.bezierCurveTo(center - key, center - key * .65, center - key * .75, center - key * 1.45, center, center - key * 1.7);
    spriteContext.bezierCurveTo(center + key * .78, center - key * 1.3, center + key, center - key * .55, center, center);
    spriteContext.fill();
  }
  const result = { canvas: sprite, cssSize };
  petalSprites.set(key, result);
  return result;
}

function drawPetal(petal: Petal): void {
  if (!context) return;
  const { canvas: sprite, cssSize } = getPetalSprite(petal.size);
  context.save();
  context.translate(petal.x, petal.y);
  context.rotate(petal.rotation);
  context.globalAlpha = petal.opacity;
  context.drawImage(sprite, -cssSize / 2, -cssSize / 2);
  context.restore();
}

function animate(): void {
  if (!context || !canvas || !preferences.sakuraEnabled || reducedMotion.matches || document.hidden) return;
  context.clearRect(0, 0, width, height);
  for (const petal of petals) {
    petal.y += petal.speed;
    petal.x += petal.drift + Math.sin(petal.y / 55) * .22;
    petal.rotation += petal.spin;
    if (petal.y > height + 24 || petal.x < -30 || petal.x > width + 30) Object.assign(petal, randomPetal(true));
    drawPetal(petal);
  }
  frame = requestAnimationFrame(animate);
}

function stop(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  context?.clearRect(0, 0, width, height);
}

function scheduleResize(): void {
  if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = undefined;
    if (preferences.sakuraEnabled && !reducedMotion.matches) resize();
  }, 120);
}

function updateToggle(): void {
  if (!toggle) return;
  const active = preferences.sakuraEnabled && !reducedMotion.matches;
  toggle.setAttribute("aria-pressed", String(active));
  toggle.classList.toggle("is-active", active);
  toggle.title = reducedMotion.matches ? "系统已启用减少动态效果" : active ? "关闭樱花特效" : "开启樱花特效";
  const label = toggle.querySelector<HTMLElement>("span");
  if (label) label.textContent = active ? "特效开" : "特效关";
}

function updateEffect(): void {
  stop();
  updateToggle();
  if (preferences.sakuraEnabled && !reducedMotion.matches) {
    resize();
    frame = requestAnimationFrame(animate);
  }
}

syncMascotPreference();
updateEffect();

toggle?.addEventListener("click", () => {
  if (reducedMotion.matches) return;
  preferences.sakuraEnabled = !preferences.sakuraEnabled;
  savePreferences();
  updateEffect();
});

document.addEventListener("click", (event) => {
  if ((event.target as Element | null)?.closest("#waifu-tool-quit")) {
    preferences.mascotVisible = false;
    savePreferences();
  }
  if ((event.target as Element | null)?.closest("#waifu-toggle")) {
    preferences.mascotVisible = true;
    savePreferences();
  }
});

window.addEventListener("resize", scheduleResize);
document.addEventListener("visibilitychange", () => document.hidden ? stop() : updateEffect());
reducedMotion.addEventListener("change", updateEffect);
