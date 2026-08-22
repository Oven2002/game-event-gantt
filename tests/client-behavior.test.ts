// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelinePayload } from "../src/lib/types";

// ── Lightweight DOM and browser API shims ───────────────────────────────────
// jsdom has no layout engine or pointer capture. These shims cover only the
// APIs used by the timeline: matchMedia disables hover enhancement and rAF uses
// a manually controlled queue for deterministic progression.

let rafQueue: FrameRequestCallback[];

function installTimelineFixture(payload: TimelinePayload): void {
  document.body.innerHTML = `
    <script id="timeline-data" type="application/json"></script>
    <section id="timeline" class="timeline"></section>
    <section id="empty-state" class="empty-state" hidden></section>
    <dialog id="detail-dialog" class="detail-dialog">
      <button class="detail-dialog__close" type="button" data-close-detail></button>
      <div id="detail-content"></div>
    </dialog>
    <fieldset data-filter="game"><input type="checkbox" value="demo" checked /></fieldset>
    <fieldset data-filter="region"><input type="checkbox" value="cn" checked /></fieldset>
    <fieldset data-filter="type"><input type="checkbox" value="event" checked /></fieldset>
    <fieldset data-filter="status">
      <input type="checkbox" value="ongoing" checked />
      <input type="checkbox" value="upcoming" checked />
      <input type="checkbox" value="ended" />
    </fieldset>
    <span data-filter-count="game"></span>
    <button data-action="zoom-in"></button>
    <button data-action="zoom-out"></button>
    <button data-action="today"></button>
  `;
  document.getElementById("timeline-data")!.textContent = JSON.stringify(payload);
}

function timelinePayloadFixture(): TimelinePayload {
  const start = Date.now() - 86_400_000;
  const end = Date.now() + 86_400_000;
  return {
    generatedAt: Date.now(),
    eventTypes: [{ id: "event", name: "活动" }],
    groups: [{
      key: "demo/cn",
      game: { id: "demo", name: "演示游戏", priority: 1 },
      region: { id: "cn", name: "国服" },
      versions: [{
        key: "demo/cn/version/v1",
        id: "v1",
        kind: "version",
        name: "V1 演示版本",
        typeId: "version",
        typeName: "版本",
        start,
        end,
        periods: [{ start, end }],
        related: [],
        sources: ["https://example.com/v1"],
        sourceFile: "demo/cn.yaml",
      }],
      events: [{
        key: "demo/cn/event/e1",
        id: "e1",
        kind: "event",
        name: "演示活动",
        typeId: "event",
        typeName: "活动",
        start: Date.now() + 3_600_000,
        end: Date.now() + 10_800_000,
        periods: [{ start: Date.now() + 3_600_000, end: Date.now() + 10_800_000 }],
        lifecycle: "permanent",
        related: ["v1"],
        sources: ["https://example.com/e1"],
        sourceFile: "demo/cn.yaml",
      }],
    }],
    bounds: { start, end },
  };
}

function flushFrames(count = 1): void {
  for (let i = 0; i < count && rafQueue.length; i += 1) {
    rafQueue.shift()!(Date.now());
  }
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = "";
  rafQueue = [];
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  }) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as unknown as typeof window.cancelAnimationFrame;
  window.setInterval = (() => 1) as unknown as typeof window.setInterval;
  window.scrollTo = (() => {}) as unknown as typeof window.scrollTo;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

describe("时间轴客户端行为", () => {
  it("渲染分组图表并在点击条目时打开详情对话框", async () => {
    installTimelineFixture(timelinePayloadFixture());
    await import("../src/scripts/timeline");

    expect(document.querySelectorAll(".timeline-group")).toHaveLength(1);
    expect(document.querySelector<SVGSVGElement>(".gantt-svg")).toBeTruthy();
    expect(document.body.textContent).toContain("常驻内容");

    document.querySelector<SVGElement>(".item-shape")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(document.getElementById("detail-dialog")!.hasAttribute("open")).toBe(true);
    expect(document.getElementById("detail-title")!.textContent).toBe("V1 演示版本");
    const sourceHrefs = [...document.querySelectorAll(".detail-grid a")]
      .map((link) => link.getAttribute("href"));
    expect(sourceHrefs).toContain("https://example.com/v1");
  });

  it("筛选变化写入偏好并在动画帧合并重渲染", async () => {
    installTimelineFixture(timelinePayloadFixture());
    await import("../src/scripts/timeline");
    // Drain the initial scroll-restoration callback so only the filter render remains.
    flushFrames(1);

    const input = document.querySelector<HTMLInputElement>('[data-filter="game"] input')!;
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushFrames(1);

    expect(document.querySelector(".timeline-group")).toBeNull();
    expect(document.getElementById("empty-state")!.hidden).toBe(false);
    const stored = JSON.parse(localStorage.getItem("game-event-gantt.preferences.v1")!);
    expect(stored.filters.game).toEqual({ demo: false });
    expect(document.querySelector('[data-filter-count="game"]')!.textContent).toBe("(0/1)");
  });

  it("拖拽期间推迟重建，手势结束后补渲染", async () => {
    installTimelineFixture(timelinePayloadFixture());
    await import("../src/scripts/timeline");
    // Drain the initial scroll-restoration callback.
    flushFrames(1);

    const chart = document.querySelector<SVGSVGElement>(".gantt-svg")!;
    const pointerEvent = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x });
      Object.defineProperty(event, "pointerId", { value: 1 });
      return event;
    };
    chart.dispatchEvent(pointerEvent("pointerdown", 100));
    chart.dispatchEvent(pointerEvent("pointermove", 160));

    const input = document.querySelector<HTMLInputElement>('[data-filter="game"] input')!;
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushFrames(1);
    // The chart DOM must remain unchanged while the gesture is active.
    expect(document.querySelector(".gantt-svg")).toBe(chart);

    chart.dispatchEvent(pointerEvent("pointerup", 160));
    flushFrames(1);
    expect(document.querySelector(".gantt-svg")).toBeNull();
    expect(document.getElementById("empty-state")!.hidden).toBe(false);
  });
});

describe("樱花特效客户端行为", () => {
  it("花瓣按尺寸复用渐变，切换后持久化偏好", async () => {
    document.body.innerHTML = `
      <canvas id="sakura-canvas" class="sakura-canvas"></canvas>
      <button class="effect-toggle" type="button" data-effect-toggle aria-pressed="true" title="关闭樱花特效">
        <i aria-hidden="true">✦</i><span>特效开</span>
      </button>
    `;
    let gradientCalls = 0;
    let drawCalls = 0;
    const fakeContext = {
      setTransform: () => {},
      createLinearGradient: () => {
        gradientCalls += 1;
        return { addColorStop: () => {} };
      },
      beginPath: () => {},
      moveTo: () => {},
      bezierCurveTo: () => {},
      fill: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      drawImage: () => { drawCalls += 1; },
      clearRect: () => {},
      globalAlpha: 1,
      fillStyle: "",
    };
    HTMLCanvasElement.prototype.getContext = (() => fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    await import("../src/scripts/effects");
    flushFrames(3);

    expect(drawCalls).toBeGreaterThan(0);
    // With at most 20 particles, size-based gradient caching must not create
    // more sprites than the particle count.
    expect(gradientCalls).toBeLessThanOrEqual(20);

    const toggle = document.querySelector<HTMLButtonElement>("[data-effect-toggle]")!;
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushFrames(1);

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.querySelector("span")!.textContent).toBe("特效关");
    expect(JSON.parse(localStorage.getItem("game-event-gantt.effects.v1")!))
      .toEqual({ sakuraEnabled: false, mascotVisible: true });
  });
});
