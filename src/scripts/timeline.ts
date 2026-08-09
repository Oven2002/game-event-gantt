import type { TimelineGroup, TimelineItem, TimelinePayload, TimelineStatus } from "../lib/types";
import { statusAt } from "../lib/types";

const NS = "http://www.w3.org/2000/svg";
const DAY = 86_400_000;
const MINUTE = 60_000;
const STATUS_NAMES: Record<TimelineStatus, string> = {
  upcoming: "即将开始",
  ongoing: "进行中",
  ended: "已结束",
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`时间表页面缺少必要容器：${selector}`);
  return element;
}

const payloadElement = requiredElement<HTMLScriptElement>("#timeline-data");
const timeline = requiredElement<HTMLElement>("#timeline");
const emptyState = requiredElement<HTMLElement>("#empty-state");
const dialog = requiredElement<HTMLDialogElement>("#detail-dialog");
const detailRoot = requiredElement<HTMLElement>("#detail-content");

const payload = JSON.parse(payloadElement.textContent ?? "") as TimelinePayload;
let now = Date.now();
let domainStart = now - 45 * DAY;
let domainEnd = now + 45 * DAY;
const collapsed = new Set<string>();
let resizeTimer: number | undefined;

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function selected(filter: string): Set<string> {
  return new Set(
    [...document.querySelectorAll<HTMLInputElement>(`[data-filter="${filter}"] input:checked`)]
      .map((input) => input.value),
  );
}

function updateFilterCounts(): void {
  for (const filter of ["game", "region", "type", "status"]) {
    const total = document.querySelectorAll(`[data-filter="${filter}"] input`).length;
    const active = document.querySelectorAll(`[data-filter="${filter}"] input:checked`).length;
    const output = document.querySelector<HTMLElement>(`[data-filter-count="${filter}"]`);
    if (output) output.textContent = `(${active}/${total})`;
  }
}

function formatDate(timestamp: number, includeYear = true): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: includeYear ? "numeric" : undefined,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

function formatTick(timestamp: number, span: number): string {
  if (span <= 2 * DAY) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(timestamp);
  }
  if (span <= 120 * DAY) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(timestamp);
  }
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "2-digit", month: "short" }).format(timestamp);
}

function tickStep(span: number): number {
  const candidates = [15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 3 * 60 * MINUTE, 6 * 60 * MINUTE, 12 * 60 * MINUTE, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 180 * DAY];
  return candidates.find((candidate) => span / candidate <= 10) ?? 365 * DAY;
}

function filteredGroups(): Array<{ group: TimelineGroup; versions: TimelineItem[]; events: TimelineItem[] }> {
  const gameIds = selected("game");
  const regionIds = selected("region");
  const typeIds = selected("type");
  const statuses = selected("status") as Set<TimelineStatus>;
  return payload.groups.flatMap((group) => {
    if (!gameIds.has(group.game.id) || !regionIds.has(group.region.id)) return [];
    const versions = group.versions.filter((item) => statuses.has(statusAt(item, now)));
    const events = group.events.filter((item) => typeIds.has(item.typeId) && statuses.has(statusAt(item, now)));
    return versions.length || events.length ? [{ group, versions, events }] : [];
  });
}

function setText(node: Element, text: string): void {
  node.textContent = text;
}

function addSvgTitle(node: SVGElement, item: TimelineItem): void {
  const title = svg("title");
  title.textContent = `${item.name}：${formatDate(item.start)}${item.end ? ` — ${formatDate(item.end)}` : ""}`;
  node.append(title);
}

function showDetail(group: TimelineGroup, item: TimelineItem): void {
  detailRoot.replaceChildren();
  const content = html("div", "detail-content");
  const kicker = html("div", "detail-kicker");
  kicker.textContent = `${group.game.name} · ${group.region.name} · ${item.typeName}`;
  const heading = html("h2");
  heading.id = "detail-title";
  heading.textContent = item.name;
  const list = html("dl", "detail-grid");

  const addRow = (label: string, value: string | Node) => {
    const term = html("dt");
    term.textContent = label;
    const description = html("dd");
    if (typeof value === "string") description.textContent = value;
    else description.append(value);
    list.append(term, description);
  };

  const status = statusAt(item, now);
  const pill = html("span", `status-pill status-pill--${status}`);
  pill.textContent = STATUS_NAMES[status];
  addRow("状态", pill);
  addRow("开始", formatDate(item.start));
  if (item.end !== undefined) addRow("结束", formatDate(item.end));
  if (item.related.length) {
    const names = new Map(group.versions.map((version) => [version.id, version.name]));
    addRow("关联版本", item.related.map((id) => names.get(id) ?? id).join("、"));
  }
  if (item.note) addRow("备注", item.note);
  if (item.url) {
    const link = html("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开官方详情";
    addRow("详情", link);
  }
  const sources = html("div");
  item.sources.forEach((source, index) => {
    const link = html("a");
    link.href = source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.sources.length === 1 ? "查看来源" : `来源 ${index + 1}`;
    if (index) sources.append(document.createTextNode(" · "));
    sources.append(link);
  });
  addRow("数据来源", sources);
  content.append(kicker, heading, list);
  detailRoot.append(content);
  dialog.showModal();
}

function bindItemInteraction(node: SVGElement, group: TimelineGroup, item: TimelineItem): void {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `查看 ${item.name} 详情`);
  addSvgTitle(node, item);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    showDetail(group, item);
  });
  node.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      showDetail(group, item);
    }
  });
}

function applyDomain(start: number, end: number): void {
  const center = (start + end) / 2;
  const maxSpan = Math.max(2 * 365 * DAY, (payload.bounds.end - payload.bounds.start) * 1.25, DAY);
  const span = Math.min(maxSpan, Math.max(60 * MINUTE, end - start));
  domainStart = center - span / 2;
  domainEnd = center + span / 2;
}

function zoomAt(factor: number, anchor = (domainStart + domainEnd) / 2): void {
  const span = domainEnd - domainStart;
  const nextSpan = span * factor;
  const ratio = (anchor - domainStart) / span;
  applyDomain(anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio));
  render();
}

function installNavigation(chart: SVGSVGElement, chartLeft: number, chartWidth: number): void {
  let dragX: number | undefined;
  let dragDomainStart = 0;
  let moved = false;
  const pointers = new Map<number, number>();
  let pinchDistance = 0;
  let pinchStartDomain: [number, number] = [domainStart, domainEnd];
  let pendingDomain: [number, number] | undefined;

  chart.addEventListener("wheel", (event) => {
    event.preventDefault();
    const bounds = chart.getBoundingClientRect();
    const x = Math.max(0, Math.min(chartWidth, event.clientX - bounds.left - chartLeft));
    const anchor = domainStart + (x / chartWidth) * (domainEnd - domainStart);
    zoomAt(Math.exp(event.deltaY * 0.0015), anchor);
  }, { passive: false });

  chart.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, event.clientX);
    chart.setPointerCapture(event.pointerId);
    if (pointers.size === 1) {
      dragX = event.clientX;
      dragDomainStart = domainStart;
      moved = false;
      chart.classList.add("is-dragging");
    } else if (pointers.size === 2) {
      const values = [...pointers.values()];
      pinchDistance = Math.abs(values[1] - values[0]);
      pinchStartDomain = [domainStart, domainEnd];
    }
  });

  chart.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event.clientX);
    if (pointers.size === 2) {
      const values = [...pointers.values()];
      const distance = Math.abs(values[1] - values[0]);
      if (pinchDistance > 10 && distance > 10) {
        const center = (pinchStartDomain[0] + pinchStartDomain[1]) / 2;
        const span = (pinchStartDomain[1] - pinchStartDomain[0]) * (pinchDistance / distance);
        pendingDomain = [center - span / 2, center + span / 2];
        moved = true;
      }
      return;
    }
    if (dragX === undefined) return;
    const delta = event.clientX - dragX;
    if (Math.abs(delta) > 3) moved = true;
    const span = domainEnd - domainStart;
    const nextStart = dragDomainStart - (delta / chartWidth) * span;
    pendingDomain = [nextStart, nextStart + span];
  });

  const finish = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    dragX = undefined;
    chart.classList.remove("is-dragging");
    if (moved && pendingDomain) {
      applyDomain(...pendingDomain);
      pendingDomain = undefined;
      render();
    }
    if (moved) {
      chart.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true });
    }
  };
  chart.addEventListener("pointerup", finish);
  chart.addEventListener("pointercancel", finish);
}

function drawChart(container: HTMLElement, entry: ReturnType<typeof filteredGroups>[number]): void {
  const { group, versions, events } = entry;
  const width = Math.max(container.clientWidth, 620);
  const chartLeft = width < 760 ? 130 : 170;
  const right = 18;
  const plotWidth = width - chartLeft - right;
  const axisHeight = 38;
  const rowHeight = 42;
  const rows: Array<{ label: string; type: string; items: TimelineItem[] }> = [];
  if (versions.length) rows.push({ label: "版本", type: "版本轨道", items: versions });
  for (const event of events) rows.push({ label: event.name, type: event.typeName, items: [event] });
  const height = axisHeight + rows.length * rowHeight + 10;
  const labelOverlay = html("div", "chart-label-overlay");
  labelOverlay.style.width = `${chartLeft}px`;
  labelOverlay.style.height = `${height}px`;
  rows.forEach((row, index) => {
    const labelRow = html("div", "chart-label-row");
    labelRow.style.top = `${axisHeight + index * rowHeight}px`;
    const name = html("strong");
    name.textContent = row.label.length > 15 ? `${row.label.slice(0, 14)}…` : row.label;
    const type = html("small");
    type.textContent = row.type;
    labelRow.append(name, type);
    labelOverlay.append(labelRow);
  });
  container.parentElement?.append(labelOverlay);
  const chart = svg("svg", { class: "gantt-svg", viewBox: `0 0 ${width} ${height}`, height });
  chart.setAttribute("aria-label", `${group.game.name}${group.region.name}时间轴`);
  const clipId = `clip-${group.game.id}-${group.region.id}`;
  const defs = svg("defs");
  const clip = svg("clipPath", { id: clipId });
  clip.append(svg("rect", { x: chartLeft, y: 0, width: plotWidth, height }));
  defs.append(clip);
  chart.append(defs);

  const span = domainEnd - domainStart;
  const x = (timestamp: number) => chartLeft + ((timestamp - domainStart) / span) * plotWidth;
  const clipped = svg("g", { "clip-path": `url(#${clipId})` });
  const step = tickStep(span);
  const firstTick = Math.floor(domainStart / step) * step;
  for (let tick = firstTick; tick <= domainEnd + step; tick += step) {
    const tickX = x(tick);
    clipped.append(svg("line", { class: "grid-line", x1: tickX, x2: tickX, y1: 28, y2: height }));
    const label = svg("text", { class: "axis-label", x: tickX + 4, y: 18 });
    setText(label, formatTick(tick, span));
    clipped.append(label);
  }

  rows.forEach((row, index) => {
    const top = axisHeight + index * rowHeight;
    const centerY = top + rowHeight / 2;
    chart.append(svg("line", { class: "row-line", x1: 0, x2: width, y1: top, y2: top }));
    const label = svg("text", { class: "row-label", x: 14, y: centerY - 2 });
    setText(label, row.label.length > 15 ? `${row.label.slice(0, 14)}…` : row.label);
    const type = svg("text", { class: "row-type", x: 14, y: centerY + 13 });
    setText(type, row.type);
    chart.append(label, type);

    for (const item of row.items) {
      const status = statusAt(item, now);
      const itemEnd = item.end ?? item.start;
      if (itemEnd < domainStart || item.start > domainEnd) {
        const onLeft = itemEnd < domainStart;
        const markerX = onLeft ? chartLeft + 9 : chartLeft + plotWidth - 9;
        const groupNode = svg("g", { class: `item-shape offscreen-item item-${status}` });
        const points = onLeft
          ? `${markerX - 7},${centerY} ${markerX + 3},${centerY - 7} ${markerX + 3},${centerY + 7}`
          : `${markerX + 7},${centerY} ${markerX - 3},${centerY - 7} ${markerX - 3},${centerY + 7}`;
        groupNode.append(svg("polygon", { class: "offscreen-marker", points }));
        const date = svg("text", {
          class: "offscreen-label",
          x: onLeft ? markerX + 8 : markerX - 8,
          y: centerY + 4,
          "text-anchor": onLeft ? "start" : "end",
        });
        setText(date, formatDate(onLeft ? itemEnd : item.start, false));
        groupNode.append(date);
        bindItemInteraction(groupNode, group, item);
        clipped.append(groupNode);
        continue;
      }
      if (item.end !== undefined) {
        const startX = x(item.start);
        const endX = x(item.end);
        const groupNode = svg("g", { class: `item-shape item-${status}` });
        const rect = svg("rect", {
          class: item.kind === "version" ? "version-bar" : "event-bar",
          x: startX,
          y: centerY - 10,
          width: Math.max(2, endX - startX),
          height: 20,
          rx: 5,
        });
        groupNode.append(rect);
        if (endX - startX > 42) {
          const text = svg("text", { class: "bar-label", x: startX + 7, y: centerY + 4 });
          setText(text, item.name);
          groupNode.append(text);
        }
        bindItemInteraction(groupNode, group, item);
        clipped.append(groupNode);
      } else {
        const pointX = x(item.start);
        const groupNode = svg("g", { class: `item-shape item-${status}` });
        groupNode.append(svg("line", { class: "point-stem", x1: pointX, x2: pointX, y1: centerY - 15, y2: centerY + 15 }));
        groupNode.append(svg("polygon", { class: "point-marker", points: `${pointX},${centerY - 7} ${pointX + 7},${centerY} ${pointX},${centerY + 7} ${pointX - 7},${centerY}` }));
        bindItemInteraction(groupNode, group, item);
        clipped.append(groupNode);
      }
    }
  });

  if (now >= domainStart && now <= domainEnd) {
    const nowX = x(now);
    clipped.append(svg("line", { class: "now-line", x1: nowX, x2: nowX, y1: 24, y2: height }));
    const label = svg("text", { class: "now-label", x: nowX + 5, y: 33 });
    setText(label, "现在");
    clipped.append(label);
  }
  chart.append(clipped);
  container.append(chart);
  installNavigation(chart, chartLeft, plotWidth);
}

function render(): void {
  const groups = filteredGroups();
  timeline.replaceChildren();
  emptyState.hidden = groups.length > 0;
  timeline.hidden = groups.length === 0;
  for (const entry of groups) {
    const section = html("section", "timeline-group");
    if (!collapsed.has(entry.group.key)) section.setAttribute("open", "");
    const heading = html("button", "group-heading");
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(!collapsed.has(entry.group.key)));
    const chevron = html("span", "group-chevron");
    chevron.textContent = "›";
    const title = html("strong");
    title.textContent = entry.group.game.name;
    const region = html("small");
    region.textContent = entry.group.region.name;
    const count = html("small");
    count.textContent = `${entry.versions.length + entry.events.length} 个条目`;
    heading.append(chevron, title, region, count);
    const chartFrame = html("div", "chart-frame");
    const chartContainer = html("div", "chart-scroll");
    chartFrame.append(chartContainer);
    if (collapsed.has(entry.group.key)) chartFrame.hidden = true;
    heading.addEventListener("click", () => {
      const isCollapsed = collapsed.has(entry.group.key);
      if (isCollapsed) collapsed.delete(entry.group.key);
      else collapsed.add(entry.group.key);
      render();
    });
    section.append(heading, chartFrame);
    timeline.append(section);
    if (!collapsed.has(entry.group.key)) drawChart(chartContainer, entry);
  }
  updateFilterCounts();
}

document.querySelectorAll<HTMLInputElement>("[data-filter] input").forEach((input) => {
  input.addEventListener("change", render);
});

document.querySelector('[data-action="zoom-in"]')?.addEventListener("click", () => zoomAt(0.65));
document.querySelector('[data-action="zoom-out"]')?.addEventListener("click", () => zoomAt(1.55));
document.querySelector('[data-action="today"]')?.addEventListener("click", () => {
  const span = domainEnd - domainStart;
  applyDomain(now - span / 2, now + span / 2);
  render();
});
document.querySelector('[data-action="all"]')?.addEventListener("click", () => {
  const rawSpan = Math.max(payload.bounds.end - payload.bounds.start, DAY);
  const padding = Math.max(rawSpan * 0.04, DAY);
  applyDomain(payload.bounds.start - padding, payload.bounds.end + padding);
  render();
});
document.querySelector("[data-close-detail]")?.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 120);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    now = Date.now();
    render();
  }
});
window.setInterval(() => {
  now = Date.now();
  render();
}, MINUTE);

render();
