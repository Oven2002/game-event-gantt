import type { TimelineGroup, TimelineItem, TimelinePayload, TimelineStatus } from "../lib/types";
import { packIntoLanes, statusAt } from "../lib/types";
import { domainAroundAnchor } from "../lib/timeline-domain";
import {
  defaultExpandedGameIds,
  FILTER_NAMES,
  parseTimelinePreferences,
  preferenceValue,
  type FilterName,
} from "../lib/preferences";
import {
  DAY,
  MINUTE,
  beijingDayKey,
  beijingDayStart,
  formatBeijingDate,
  formatTimelineTick,
  isBeijingWeekend,
} from "../lib/calendar";

const NS = "http://www.w3.org/2000/svg";
const INITIAL_SPAN = 28 * DAY;
const NOW_POSITION = 0.25;
const PREFERENCES_KEY = "game-event-gantt.preferences.v1";
const STATUS_NAMES: Record<TimelineStatus, string> = {
  upcoming: "即将开始",
  ongoing: "进行中",
  ended: "已结束",
};
const TIME_CERTAINTY_NAMES = {
  confirmed: "官方确认",
  inferred: "根据官方信息推定",
  estimated: "估算",
  unknown: "尚未复核",
} as const;
const SUBTYPE_NAMES: Record<string, string> = {
  main_event: "主活动", login_reward: "登录奖励", web_event: "网页活动", collaboration: "联动",
  story: "剧情内容", shop: "商店", exchange: "兑换", challenge: "挑战", season: "赛季",
  competition: "竞赛", creator_campaign: "创作征集", permanent_content: "常驻内容",
  character: "角色卡池", weapon: "武器卡池", standard: "常驻卡池", outfit: "服装卡池", mixed: "混合卡池",
  scheduled: "计划维护", hotfix: "热修复", non_downtime: "不停服更新", preload: "资源预载",
  special_program: "前瞻特别节目", livestream: "直播", pv: "PV", announcement: "公告",
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
const preferences = loadPreferences();
const defaultExpandedGames = defaultExpandedGameIds(payload.groups);
let now = Date.now();
let [domainStart, domainEnd] = domainAroundAnchor(now, INITIAL_SPAN, NOW_POSITION);
let resizeTimer: number | undefined;
let restoreScrollFrame: number | undefined;
let renderFrame: number | undefined;
let activePointers = 0;
let renderDeferred = false;

function loadPreferences() {
  try {
    return parseTimelinePreferences(window.localStorage.getItem(PREFERENCES_KEY));
  } catch {
    return parseTimelinePreferences(null);
  }
}

function savePreferences(): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // localStorage can be disabled or unavailable; preferences remain optional.
  }
}

function filterNameFor(input: HTMLInputElement): FilterName | undefined {
  const value = input.closest<HTMLElement>("[data-filter]")?.dataset.filter;
  return FILTER_NAMES.includes(value as FilterName) ? value as FilterName : undefined;
}

function restoreFilterPreferences(): void {
  document.querySelectorAll<HTMLInputElement>("[data-filter] input").forEach((input) => {
    const filterName = filterNameFor(input);
    if (!filterName) return;
    input.checked = preferenceValue(preferences.filters[filterName], input.value, input.checked);
  });
}

function isGroupOpen(group: TimelineGroup): boolean {
  return preferenceValue(
    preferences.groupOpen,
    group.key,
    defaultExpandedGames.has(group.game.id),
  );
}

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
  title.textContent = `${item.name}：${formatBeijingDate(item.start)}${item.end ? ` — ${formatBeijingDate(item.end)}` : ""}`;
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
  addRow("开始", formatBeijingDate(item.start));
  if (item.end !== undefined) addRow("结束", formatBeijingDate(item.end));
  if (item.subtype) addRow("子类型", SUBTYPE_NAMES[item.subtype] ?? item.subtype);
  const certaintyInfo = item.timeCertainty ?? { start: "unknown" as const };
  const certainty = certaintyInfo.start === certaintyInfo.end || certaintyInfo.end === undefined
    ? TIME_CERTAINTY_NAMES[certaintyInfo.start]
    : `开始：${TIME_CERTAINTY_NAMES[certaintyInfo.start]}；结束：${TIME_CERTAINTY_NAMES[certaintyInfo.end]}`;
  if (certaintyInfo.start !== "unknown" || certaintyInfo.end !== undefined && certaintyInfo.end !== "unknown") addRow("时间可信度", certainty);
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
  scheduleRender();
}

function scheduleRender(): void {
  // During drag/pinch gestures the chart DOM is being manipulated. Rebuilding it
  // would interrupt the gesture and lose pointer capture, so defer the rebuild.
  if (activePointers > 0) {
    renderDeferred = true;
    return;
  }
  if (renderFrame !== undefined) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = undefined;
    render();
  });
}

function installNavigation(chart: SVGSVGElement, chartLeft: number, chartWidth: number): void {
  const setPreviewTransform = (transform?: string) => {
    document.querySelectorAll<SVGGElement>(".plot-layer").forEach((layer) => {
      if (transform) layer.setAttribute("transform", transform);
      else layer.removeAttribute("transform");
    });
  };
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
    activePointers = pointers.size;
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
        for (const pointerId of pointers.keys()) {
          if (!chart.hasPointerCapture(pointerId)) chart.setPointerCapture(pointerId);
        }
        const center = (pinchStartDomain[0] + pinchStartDomain[1]) / 2;
        const span = (pinchStartDomain[1] - pinchStartDomain[0]) * (pinchDistance / distance);
        pendingDomain = [center - span / 2, center + span / 2];
        moved = true;
        const scale = distance / pinchDistance;
        const centerX = chartLeft + chartWidth / 2;
        setPreviewTransform(`translate(${centerX} 0) scale(${scale} 1) translate(${-centerX} 0)`);
      }
      return;
    }
    if (dragX === undefined) return;
    const delta = event.clientX - dragX;
    if (Math.abs(delta) > 3) {
      moved = true;
      if (!chart.hasPointerCapture(event.pointerId)) chart.setPointerCapture(event.pointerId);
    }
    const span = domainEnd - domainStart;
    const nextStart = dragDomainStart - (delta / chartWidth) * span;
    pendingDomain = [nextStart, nextStart + span];
    setPreviewTransform(`translate(${delta} 0)`);
  });

  const finish = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    activePointers = pointers.size;
    dragX = undefined;
    chart.classList.remove("is-dragging");
    if (moved && pendingDomain) {
      applyDomain(...pendingDomain);
      pendingDomain = undefined;
      scheduleRender();
    } else {
      setPreviewTransform();
    }
    if (moved) {
      chart.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true });
    }
    if (renderDeferred && activePointers === 0) {
      renderDeferred = false;
      scheduleRender();
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
  const rows: Array<{ label: string; type: string; items: TimelineItem[]; priority: number; kindOrder: number; start: number }> = [];
  if (versions.length) rows.push({ label: "版本", type: "版本轨道", items: versions, priority: Number.POSITIVE_INFINITY, kindOrder: 0, start: versions[0].start });
  const banners = events.filter((event) => event.typeId === "banner");
  const otherEvents = events.filter((event) => event.typeId !== "banner");
  packIntoLanes(banners).forEach((items, index) => {
    rows.push({
      label: index === 0 ? "卡池" : `卡池 ${index + 1}`,
      type: "卡池轨道",
      items,
      priority: Math.max(...items.map((item) => item.priority ?? 900)),
      kindOrder: 1,
      start: Math.min(...items.map((item) => item.start)),
    });
  });
  for (const event of otherEvents) {
    const segments = event.periods.length
      ? event.periods.map((period) => ({ ...event, start: period.start, end: period.end, periods: [period] }))
      : [event];
    const lifecycleLabel = event.typeId === "event"
      ? event.lifecycle === "permanent" && event.cadence === "rotating"
        ? "常驻轮换"
        : event.lifecycle === "permanent"
          ? "常驻内容"
          : event.lifecycle === "limited" && event.cadence === "recurring"
          ? "周期重复"
          : "限时活动"
      : undefined;
    rows.push({
      label: event.name,
      type: lifecycleLabel ? `${event.typeName} · ${lifecycleLabel}` : event.typeName,
      items: segments,
      priority: event.priority ?? 0,
      kindOrder: 2,
      start: event.start,
    });
  }
  rows.sort((a, b) =>
    b.priority - a.priority
    || a.kindOrder - b.kindOrder
    || a.start - b.start
    || a.items[0].id.localeCompare(b.items[0].id)
  );
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
  const gradientPrefix = `gradient-${group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const gradientIds = {
    version: `${gradientPrefix}-version`,
    event: `${gradientPrefix}-event`,
    banner: `${gradientPrefix}-banner`,
    maintenance: `${gradientPrefix}-maintenance`,
    preview: `${gradientPrefix}-preview`,
  };
  const defs = svg("defs");
  const clip = svg("clipPath", { id: clipId });
  clip.append(svg("rect", { x: chartLeft, y: 0, width: plotWidth, height }));
  defs.append(clip);
  const addGradient = (id: string, start: string, end: string) => {
    const gradient = svg("linearGradient", { id, x1: "0%", x2: "100%", y1: "0%", y2: "0%" });
    gradient.append(
      svg("stop", { offset: "0%", "stop-color": start }),
      svg("stop", { offset: "100%", "stop-color": end }),
    );
    defs.append(gradient);
  };
  addGradient(gradientIds.version, "#6475e0", "#9a91e1");
  addGradient(gradientIds.event, "#8a68dc", "#ce96d9");
  addGradient(gradientIds.banner, "#ee77ad", "#f7a6ca");
  addGradient(gradientIds.maintenance, "#32aaa6", "#78d0c5");
  addGradient(gradientIds.preview, "#eba25f", "#f5cc86");
  chart.append(defs);

  const gradientForItem = (item: TimelineItem): string => {
    if (item.kind === "version") return gradientIds.version;
    if (item.typeId === "banner") return gradientIds.banner;
    if (item.typeId === "maintenance") return gradientIds.maintenance;
    if (item.typeId === "preview") return gradientIds.preview;
    return gradientIds.event;
  };

  const span = domainEnd - domainStart;
  const x = (timestamp: number) => chartLeft + ((timestamp - domainStart) / span) * plotWidth;
  const plotViewport = svg("g", { "clip-path": `url(#${clipId})` });
  const clipped = svg("g", { class: "plot-layer" });
  plotViewport.append(clipped);

  // Keep calendar context visible without adding any data fields. Beijing has
  // no daylight-saving changes, so each local day is a fixed 24-hour interval.
  for (let day = beijingDayStart(domainStart); day < domainEnd; day += DAY) {
    if (!isBeijingWeekend(day + 12 * 60 * MINUTE)) continue;
    const startX = Math.max(chartLeft, x(day));
    const endX = Math.min(chartLeft + plotWidth, x(day + DAY));
    if (endX > startX) {
      clipped.append(svg("rect", {
        class: "weekend-band",
        x: startX,
        y: 0,
        width: endX - startX,
        height,
      }));
    }
  }

  const step = tickStep(span);
  const firstTick = Math.floor(domainStart / step) * step;
  for (let tick = firstTick; tick <= domainEnd + step; tick += step) {
    const tickX = x(tick);
    clipped.append(svg("line", { class: "grid-line", x1: tickX, x2: tickX, y1: 28, y2: height }));
    const tickLabel = formatTimelineTick(tick, span);
    const today = beijingDayKey(tick) === beijingDayKey(now);
    const weekend = Boolean(tickLabel.secondary) && isBeijingWeekend(tick);
    const label = svg("text", {
      class: `axis-label${today ? " axis-label--today" : ""}${weekend ? " axis-label--weekend" : ""}`,
      x: tickX + 4,
      y: tickLabel.secondary ? 14 : 18,
    });
    const primary = svg("tspan", { class: "axis-label-primary", x: tickX + 4, y: tickLabel.secondary ? 14 : 18 });
    setText(primary, tickLabel.primary);
    label.append(primary);
    if (tickLabel.secondary) {
      const secondary = svg("tspan", { class: "axis-label-secondary", x: tickX + 4, y: 29 });
      setText(secondary, tickLabel.secondary);
      label.append(secondary);
    }
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
        groupNode.append(svg("polygon", { class: "offscreen-marker", points, style: `fill:url(#${gradientForItem(item)})` }));
        const date = svg("text", {
          class: "offscreen-label",
          x: onLeft ? markerX + 8 : markerX - 8,
          y: centerY + 4,
          "text-anchor": onLeft ? "start" : "end",
        });
        setText(date, formatBeijingDate(onLeft ? itemEnd : item.start, false));
        groupNode.append(date);
        bindItemInteraction(groupNode, group, item);
        clipped.append(groupNode);
        continue;
      }
      if (item.end !== undefined) {
        const startX = x(item.start);
        const endX = x(item.end);
        const visibleStartX = Math.max(chartLeft, startX);
        const visibleEndX = Math.min(chartLeft + plotWidth, endX);
        const visibleWidth = Math.max(0, visibleEndX - visibleStartX);
        const groupNode = svg("g", { class: `item-shape item-${status}` });
        const rect = svg("rect", {
          class: item.kind === "version" ? "version-bar" : `event-bar event-bar--${item.typeId}`,
          x: startX,
          y: centerY - 10,
          width: Math.max(2, endX - startX),
          height: 20,
          rx: 10,
          style: `fill:url(#${gradientForItem(item)})`,
        });
        groupNode.append(rect);
        if (visibleWidth > 42) {
          const maxCharacters = Math.max(3, Math.floor((visibleWidth - 14) / 11));
          const fittedName = item.name.length > maxCharacters
            ? `${item.name.slice(0, maxCharacters - 1)}…`
            : item.name;
          const text = svg("text", { class: "bar-label", x: visibleStartX + 7, y: centerY + 4 });
          setText(text, fittedName);
          groupNode.append(text);
        }
        bindItemInteraction(groupNode, group, item);
        clipped.append(groupNode);
      } else {
        const pointX = x(item.start);
        const groupNode = svg("g", { class: `item-shape item-${status}` });
        groupNode.append(svg("line", { class: "point-stem", x1: pointX, x2: pointX, y1: centerY - 15, y2: centerY + 15 }));
        groupNode.append(svg("polygon", { class: "point-marker", points: `${pointX},${centerY - 7} ${pointX + 7},${centerY} ${pointX},${centerY + 7} ${pointX - 7},${centerY}`, style: `fill:url(#${gradientForItem(item)})` }));
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
  chart.append(plotViewport);
  container.append(chart);
  installNavigation(chart, chartLeft, plotWidth);
}

function render(): void {
  const pageScroll = { x: window.scrollX, y: window.scrollY };
  const chartScroll = new Map<string, number>();
  timeline.querySelectorAll<HTMLElement>(".chart-scroll[data-group-key]").forEach((container) => {
    const groupKey = container.dataset.groupKey;
    if (groupKey) chartScroll.set(groupKey, container.scrollLeft);
  });
  const groups = filteredGroups();
  timeline.replaceChildren();
  emptyState.hidden = groups.length > 0;
  timeline.hidden = groups.length === 0;
  for (const entry of groups) {
    const groupOpen = isGroupOpen(entry.group);
    const section = html("section", "timeline-group");
    if (groupOpen) section.setAttribute("open", "");
    const heading = html("button", "group-heading");
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(groupOpen));
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
    chartContainer.dataset.groupKey = entry.group.key;
    chartFrame.append(chartContainer);
    if (!groupOpen) chartFrame.hidden = true;
    heading.addEventListener("click", () => {
      preferences.groupOpen[entry.group.key] = !groupOpen;
      savePreferences();
      scheduleRender();
    });
    section.append(heading, chartFrame);
    timeline.append(section);
    if (groupOpen) {
      drawChart(chartContainer, entry);
      chartContainer.scrollLeft = chartScroll.get(entry.group.key) ?? 0;
    }
  }
  updateFilterCounts();
  window.cancelAnimationFrame(restoreScrollFrame ?? 0);
  window.scrollTo(pageScroll.x, pageScroll.y);
  restoreScrollFrame = window.requestAnimationFrame(() => {
    window.scrollTo(pageScroll.x, pageScroll.y);
  });
}

restoreFilterPreferences();

// ── Hover/focus enhancement: open filter menus on hover and close on exit ─────
// Enable this only for fine-pointer devices; touch devices keep native <details> behavior.
(function enhanceFilterMenus(): void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

  document.querySelectorAll<HTMLDetailsElement>(".filter-menu").forEach((menu) => {
    // Take over toggle behavior so native click handling does not fight hover state.
    menu.querySelector("summary")?.addEventListener("click", (e) => e.preventDefault());

    let openTimer: number | undefined;
    let closeTimer: number | undefined;

    menu.addEventListener("mouseenter", () => {
      clearTimeout(closeTimer);
      openTimer = window.setTimeout(() => { menu.open = true; }, 100);
    });

    menu.addEventListener("mouseleave", () => {
      clearTimeout(openTimer);
      closeTimer = window.setTimeout(() => {
        if (!menu.contains(document.activeElement)) menu.open = false;
      }, 200);
    });

    menu.addEventListener("focusin", () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      menu.open = true;
    });

    menu.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!menu.contains(document.activeElement) && !menu.matches(":hover")) {
          menu.open = false;
        }
      });
    });
  });
})();

document.querySelectorAll<HTMLInputElement>("[data-filter] input").forEach((input) => {
  input.addEventListener("change", () => {
    const filterName = filterNameFor(input);
    if (filterName) {
      preferences.filters[filterName] ??= {};
      preferences.filters[filterName]![input.value] = input.checked;
      savePreferences();
    }
    scheduleRender();
  });
});

document.querySelector('[data-action="zoom-in"]')?.addEventListener("click", () => zoomAt(0.65));
document.querySelector('[data-action="zoom-out"]')?.addEventListener("click", () => zoomAt(1.55));
document.querySelector('[data-action="today"]')?.addEventListener("click", () => {
  const span = domainEnd - domainStart;
  applyDomain(...domainAroundAnchor(now, span, NOW_POSITION));
  scheduleRender();
});
document.querySelector("[data-close-detail]")?.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(scheduleRender, 120);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    now = Date.now();
    scheduleRender();
  }
});
window.setInterval(() => {
  now = Date.now();
  scheduleRender();
}, MINUTE);

render();
