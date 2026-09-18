"use strict";

const EDITABLE_COLUMNS = ["planned_sub", "assignee", "details"];
const stateStore = {
  data: null,
  selected: new Set(),
  anchor: null,
  dragging: false,
  toastTimer: null,
  reconnectTimer: null,
  pendingSaves: new WeakMap(),
  undoStack: [],
  undoing: false,
  waitingForEditor: new Set(),
  viewMode: localStorage.getItem("foup-view-mode") || "sheet",
};

const elements = {
  grid: document.getElementById("foup-grid"),
  loading: document.getElementById("loading-state"),
  empty: document.getElementById("empty-state"),
  search: document.getElementById("search-input"),
  statusFilter: document.getElementById("status-filter"),
  refresh: document.getElementById("refresh-button"),
  undo: document.getElementById("undo-button"),
  cellHistory: document.getElementById("cell-history-button"),
  userName: document.getElementById("user-name"),
  palette: document.getElementById("color-palette"),
  selectionCount: document.getElementById("selection-count"),
  notice: document.getElementById("system-notice"),
  connectionPill: document.getElementById("connection-pill"),
  connectionLabel: document.getElementById("connection-label"),
  historyDrawer: document.getElementById("history-drawer"),
  historyEyebrow: document.getElementById("history-eyebrow"),
  historyTitle: document.getElementById("history-title"),
  historySubtitle: document.getElementById("history-subtitle"),
  historyContent: document.getElementById("history-content"),
  toast: document.getElementById("toast"),
  statFoups: document.getElementById("stat-foups"),
  statWafers: document.getElementById("stat-wafers"),
  statPlans: document.getElementById("stat-plans"),
  liveMode: document.getElementById("live-mode"),
  lastSync: document.getElementById("last-sync"),
  viewButtons: [...document.querySelectorAll(".view-button")],
};

function cellKey(foupId, slotNo, columnKey) {
  return `${foupId}|${slotNo}|${columnKey}`;
}

function userName() {
  return elements.userName.value.trim();
}

function requireEditorName(waitingCell = null) {
  const name = userName();
  if (name && name !== "익명 사용자") {
    elements.userName.classList.remove("editor-required");
    return name;
  }
  if (waitingCell) stateStore.waitingForEditor.add(waitingCell);
  elements.userName.classList.add("editor-required");
  showToast("수정 이력을 남기려면 편집자 이름을 먼저 입력하세요.", "error");
  elements.userName.focus();
  return null;
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-User": encodeURIComponent(userName()),
  };
}

function formatTime(value) {
  if (!value) return "동기화 시각 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function showToast(message, type = "success") {
  window.clearTimeout(stateStore.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", type === "error");
  elements.toast.classList.add("show");
  stateStore.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2600);
}

function setConnection(status, label) {
  elements.connectionPill.classList.toggle("online", status === "online");
  elements.connectionPill.classList.toggle("offline", status === "offline");
  elements.connectionLabel.textContent = label;
}

function setViewMode(mode) {
  const normalized = mode === "live" ? "live" : "sheet";
  stateStore.viewMode = normalized;
  document.body.dataset.view = normalized;
  elements.viewButtons.forEach((button) => {
    const active = button.dataset.view === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  localStorage.setItem("foup-view-mode", normalized);
}

async function loadState({ announce = false } = {}) {
  elements.refresh.classList.add("loading");
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    stateStore.data = data;
    render(data);
    if (announce) showToast("최신 정보를 불러왔습니다.");
  } catch (error) {
    elements.loading.hidden = true;
    elements.notice.hidden = false;
    elements.notice.textContent = `데이터를 불러오지 못했습니다. (${error.message})`;
    showToast("FOUP 정보를 불러오지 못했습니다.", "error");
  } finally {
    elements.refresh.classList.remove("loading");
  }
}

function render(data) {
  elements.loading.hidden = true;
  elements.grid.replaceChildren();
  stateStore.selected.clear();
  stateStore.anchor = null;
  updateSelectionLabel();

  elements.statFoups.textContent = data.summary.foup_count;
  elements.statWafers.textContent = data.summary.occupied_slots;
  elements.statPlans.textContent = data.summary.planned_slots;
  elements.lastSync.textContent = `화면 갱신 ${formatTime(data.generated_at)}`;
  elements.liveMode.textContent = data.live_mode === "demo" ? "DEMO LIVE DATA" : "COMPANY LIVE API";
  elements.liveMode.classList.toggle("demo", data.live_mode === "demo");

  if (data.live_error) {
    elements.notice.hidden = false;
    elements.notice.textContent = `${data.live_error} 계획 편집 기능은 계속 사용할 수 있습니다.`;
  } else if (data.live_mode === "demo") {
    elements.notice.hidden = false;
    elements.notice.textContent = "현재는 데모 실시간 데이터를 표시합니다. FOUP_LIVE_API_URL을 설정하면 사내 API로 전환됩니다.";
  } else {
    elements.notice.hidden = true;
  }

  data.foups.forEach((foup) => elements.grid.appendChild(buildFoupCard(foup)));
  applyFilters();
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function buildFoupCard(foup) {
  const card = document.createElement("article");
  card.className = "foup-card";
  card.dataset.foup = foup.id;
  card.dataset.status = foup.live.status || "UNAVAILABLE";
  card.style.setProperty("--header-color", foup.header_color);

  const header = document.createElement("header");
  header.className = "foup-card-header";

  const identity = document.createElement("div");
  const idLine = document.createElement("div");
  idLine.className = "foup-id-line";
  idLine.append(textNode("h2", "", foup.id), textNode("span", "material-tag", foup.category));
  identity.appendChild(idLine);

  const meta = document.createElement("div");
  meta.className = "foup-meta";
  const owner = document.createElement("span");
  owner.append("OWNER ", textNode("strong", "", foup.owner));
  const total = document.createElement("span");
  total.append("TOTAL ", textNode("strong", "", String(foup.total_slots)));
  const filled = foup.slots.filter((slot) => slot.live.wafer_id).length;
  const occupancy = document.createElement("span");
  occupancy.append("LOADED ", textNode("strong", "", `${filled}/${foup.total_slots}`));
  meta.append(owner, total, occupancy);
  identity.appendChild(meta);

  const location = document.createElement("div");
  location.className = "location-block";
  location.append(
    textNode("span", "location-label", "CURRENT LOCATION"),
    textNode("strong", "location-value", foup.live.location || "연동 정보 없음")
  );
  const badge = textNode("span", `status-badge ${foup.live.status === "ONLINE" ? "" : "unavailable"}`, foup.live.status || "UNAVAILABLE");
  location.appendChild(badge);
  header.append(identity, location);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "sheet-table";
  table.dataset.foup = foup.id;
  table.setAttribute("aria-label", `${foup.id} Slot 계획`);
  table.innerHTML = `
    <colgroup>
      <col class="slot-col"><col class="wafer-col live-column"><col class="step-col live-column">
      <col class="sub-col"><col class="user-col"><col class="detail-col">
    </colgroup>
    <thead><tr>
      <th>Slot</th><th class="live-column">현재 Wafer</th><th class="live-column">현재 Step</th>
      <th class="editable-heading">Sub <span>✎</span></th><th class="editable-heading">사용자 <span>✎</span></th><th class="editable-heading">세부사항 <span>✎</span></th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");

  foup.slots.forEach((slot) => {
    const row = document.createElement("tr");
    const slotCell = textNode("td", `slot-cell ${slot.live.wafer_id ? "loaded-slot" : ""}`, String(slot.slot_no));
    if (slot.live.wafer_id) slotCell.title = `현재 Wafer: ${slot.live.wafer_id}`;
    row.appendChild(slotCell);

    const wafer = textNode("td", `live-cell live-column wafer-cell ${slot.live.wafer_id ? "has-wafer" : "empty-wafer"}`, slot.live.wafer_id || "—");
    if (slot.live.wafer_id) {
      wafer.tabIndex = 0;
      wafer.dataset.foup = foup.id;
      wafer.dataset.slot = String(slot.slot_no);
      wafer.dataset.wafer = slot.live.wafer_id;
      wafer.title = "Wafer History 열기";
    }
    row.appendChild(wafer);
    row.appendChild(textNode("td", "live-cell live-column", slot.live.current_step || "—"));

    EDITABLE_COLUMNS.forEach((columnKey) => {
      const cell = slot.cells[columnKey];
      const td = textNode("td", "editable-cell", cell.value || "");
      td.contentEditable = "true";
      td.spellcheck = false;
      td.tabIndex = 0;
      td.dataset.foup = foup.id;
      td.dataset.slot = String(slot.slot_no);
      td.dataset.column = columnKey;
      td.dataset.version = String(cell.version);
      td.dataset.original = cell.value || "";
      td.dataset.updatedBy = cell.updated_by || "";
      td.dataset.placeholder = "입력";
      td.setAttribute("aria-placeholder", "입력");
      td.setAttribute("role", "gridcell");
      td.setAttribute("aria-label", `${foup.id} ${slot.slot_no}번 ${columnKey}`);
      if (cell.color) {
        td.style.backgroundColor = cell.color;
        td.dataset.color = cell.color;
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  card.append(header, tableWrap);

  const searchable = [
    foup.id,
    foup.category,
    foup.owner,
    foup.live.location,
    ...foup.slots.flatMap((slot) => [
      slot.live.wafer_id,
      slot.live.current_step,
      ...EDITABLE_COLUMNS.map((key) => slot.cells[key].value),
    ]),
  ].filter(Boolean).join(" ").toLocaleLowerCase("ko-KR");
  card.dataset.search = searchable;
  return card;
}

function applyFilters() {
  const query = elements.search.value.trim().toLocaleLowerCase("ko-KR");
  const status = elements.statusFilter.value;
  let visible = 0;
  document.querySelectorAll(".foup-card").forEach((card) => {
    const matchesQuery = !query || card.dataset.search.includes(query);
    const matchesStatus = status === "all" || card.dataset.status === status;
    card.hidden = !(matchesQuery && matchesStatus);
    if (!card.hidden) visible += 1;
  });
  elements.empty.hidden = visible !== 0;
}

function getCellByKey(key) {
  const [foupId, slotNo, columnKey] = key.split("|");
  return document.querySelector(
    `.editable-cell[data-foup="${CSS.escape(foupId)}"][data-slot="${slotNo}"][data-column="${columnKey}"]`
  );
}

function selectOnly(cell) {
  clearSelection();
  const key = cellKey(cell.dataset.foup, cell.dataset.slot, cell.dataset.column);
  stateStore.selected.add(key);
  stateStore.anchor = key;
  cell.classList.add("selected");
  updateSelectionLabel();
}

function toggleSelection(cell) {
  const key = cellKey(cell.dataset.foup, cell.dataset.slot, cell.dataset.column);
  if (stateStore.selected.has(key)) {
    stateStore.selected.delete(key);
    cell.classList.remove("selected");
  } else {
    stateStore.selected.add(key);
    cell.classList.add("selected");
    stateStore.anchor = key;
  }
  updateSelectionLabel();
}

function clearSelection() {
  document.querySelectorAll(".editable-cell.selected").forEach((cell) => cell.classList.remove("selected"));
  stateStore.selected.clear();
  updateSelectionLabel();
}

function selectRange(anchorKey, targetCell, additive = false) {
  const [anchorFoup, anchorSlotText, anchorColumn] = anchorKey.split("|");
  if (anchorFoup !== targetCell.dataset.foup) {
    selectOnly(targetCell);
    return;
  }
  if (!additive) clearSelection();
  const startSlot = Number(anchorSlotText);
  const endSlot = Number(targetCell.dataset.slot);
  const startColumn = EDITABLE_COLUMNS.indexOf(anchorColumn);
  const endColumn = EDITABLE_COLUMNS.indexOf(targetCell.dataset.column);
  const minSlot = Math.min(startSlot, endSlot);
  const maxSlot = Math.max(startSlot, endSlot);
  const minColumn = Math.min(startColumn, endColumn);
  const maxColumn = Math.max(startColumn, endColumn);
  for (let slot = minSlot; slot <= maxSlot; slot += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const key = cellKey(anchorFoup, slot, EDITABLE_COLUMNS[column]);
      const cell = getCellByKey(key);
      if (cell) {
        stateStore.selected.add(key);
        cell.classList.add("selected");
      }
    }
  }
  updateSelectionLabel();
}

function updateSelectionLabel() {
  const count = stateStore.selected.size;
  elements.selectionCount.textContent = count
    ? `${count}개 셀 선택됨`
    : "셀을 선택하면 색을 지정할 수 있습니다.";
  elements.cellHistory.disabled = count !== 1;
}

function updateUndoButton() {
  elements.undo.disabled = !stateStore.undoStack.length || stateStore.undoing;
}

function rememberOperation(operationId) {
  if (!operationId) return;
  if (stateStore.undoStack.at(-1) !== operationId) {
    stateStore.undoStack.push(operationId);
  }
  if (stateStore.undoStack.length > 50) stateStore.undoStack.shift();
  updateUndoButton();
}

function normalizeCellText(cell) {
  return cell.innerText.replace(/\r?\n/g, " ").replace(/\u00a0/g, " ");
}

async function saveCell(cell, { moveAfter = null } = {}) {
  if (!cell || !cell.classList.contains("editable-cell")) return true;
  const pending = stateStore.pendingSaves.get(cell);
  if (pending) {
    const pendingResult = await pending;
    if (normalizeCellText(cell) !== (cell.dataset.original || "")) {
      return saveCell(cell, { moveAfter });
    }
    if (pendingResult && moveAfter) moveFocus(cell, moveAfter);
    return pendingResult;
  }

  const value = normalizeCellText(cell);
  const original = cell.dataset.original || "";
  if (value === original) {
    if (moveAfter) moveFocus(cell, moveAfter);
    return true;
  }
  if (!requireEditorName(cell)) return false;
  stateStore.waitingForEditor.delete(cell);

  const operation = (async () => {
    cell.classList.add("saving");
    try {
      const response = await fetch(
        `/api/cells/${encodeURIComponent(cell.dataset.foup)}/${cell.dataset.slot}/${cell.dataset.column}`,
        {
          method: "PATCH",
          headers: apiHeaders(),
          body: JSON.stringify({
            value,
            expected_version: Number(cell.dataset.version),
          }),
        }
      );
      const body = await response.json();
      if (response.status === 409) {
        applyCellUpdate(body.current, { force: true });
        cell.classList.add("conflict");
        window.setTimeout(() => cell.classList.remove("conflict"), 1600);
        showToast(`충돌 감지: ${body.current.updated_by}님의 최신 값을 반영했습니다.`, "error");
        return false;
      }
      if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
      applyCellUpdate(body, { force: true });
      rememberOperation(body.operation_id);
      return true;
    } catch (error) {
      cell.textContent = original;
      showToast(`저장 실패: ${error.message}`, "error");
      return false;
    } finally {
      cell.classList.remove("saving");
    }
  })();
  stateStore.pendingSaves.set(cell, operation);
  try {
    const result = await operation;
    if (result && moveAfter) moveFocus(cell, moveAfter);
    return result;
  } finally {
    if (stateStore.pendingSaves.get(cell) === operation) {
      stateStore.pendingSaves.delete(cell);
    }
  }
}

function applyCellUpdate(update, { force = false } = {}) {
  if (!update) return;
  const key = cellKey(update.foup_id, update.slot_no, update.column_key);
  const cell = getCellByKey(key);
  if (!cell) return;
  const isFocusedAndDirty = document.activeElement === cell && normalizeCellText(cell) !== (cell.dataset.original || "");
  if (force || !isFocusedAndDirty) {
    cell.textContent = update.value || "";
    cell.dataset.original = update.value || "";
  }
  cell.dataset.version = String(update.version);
  cell.dataset.updatedBy = update.updated_by || "";
  cell.dataset.color = update.color || "";
  cell.style.backgroundColor = update.color || "";
}

function moveFocus(cell, direction) {
  const slot = Number(cell.dataset.slot);
  let column = EDITABLE_COLUMNS.indexOf(cell.dataset.column);
  let targetSlot = slot;
  if (direction === "down") targetSlot += 1;
  if (direction === "up") targetSlot -= 1;
  if (direction === "right") {
    column += 1;
    if (column >= EDITABLE_COLUMNS.length) {
      column = 0;
      targetSlot += 1;
    }
  }
  if (direction === "left") {
    column -= 1;
    if (column < 0) {
      column = EDITABLE_COLUMNS.length - 1;
      targetSlot -= 1;
    }
  }
  if (targetSlot < 1 || targetSlot > 25) return;
  const target = getCellByKey(cellKey(cell.dataset.foup, targetSlot, EDITABLE_COLUMNS[column]));
  if (target) {
    selectOnly(target);
    target.focus();
    placeCaretAtEnd(target);
  }
}

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function applyColor(color) {
  if (!stateStore.selected.size) {
    showToast("먼저 색을 지정할 셀을 선택하세요.", "error");
    return;
  }
  const selectedCells = [...stateStore.selected]
    .map(getCellByKey)
    .filter(Boolean);
  await Promise.all(selectedCells.map((cell) => saveCell(cell)));
  const updates = [];
  selectedCells.forEach((cell) => {
    updates.push({
      foup_id: cell.dataset.foup,
      slot_no: Number(cell.dataset.slot),
      column_key: cell.dataset.column,
      color: color || null,
      expected_version: Number(cell.dataset.version),
    });
  });
  await saveBatch(updates, color ? "예약 색상을 적용했습니다." : "셀 색상을 지웠습니다.");
}

async function saveBatch(updates, successMessage, { force = false } = {}) {
  if (!updates.length) return false;
  if (!requireEditorName()) return false;
  try {
    const response = await fetch("/api/cells/batch", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ updates }),
    });
    const body = await response.json();
    if (response.status === 409) {
      applyCellUpdate(body.current, { force: true });
      showToast("다른 사용자의 수정과 겹쳤습니다. 최신 값을 반영했습니다.", "error");
      return false;
    }
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    body.cells.forEach((cell) => applyCellUpdate(cell, { force }));
    rememberOperation(body.operation_id);
    showToast(successMessage);
    return true;
  } catch (error) {
    showToast(`저장 실패: ${error.message}`, "error");
    return false;
  }
}

async function undoLastOperation({ pendingSave = null } = {}) {
  if (stateStore.undoing) return;
  if (!requireEditorName()) return;
  stateStore.undoing = true;
  updateUndoButton();
  try {
    if (pendingSave) await pendingSave;
    const operationId = stateStore.undoStack.at(-1);
    if (!operationId) {
      showToast("현재 화면에서 되돌릴 작업이 없습니다. 셀 변경 이력을 확인하세요.", "error");
      return;
    }
    const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}/undo`, {
      method: "POST",
      headers: apiHeaders(),
    });
    const body = await response.json();
    stateStore.undoStack.pop();
    if (response.status === 409) {
      stateStore.undoStack.length = 0;
      applyCellUpdate(body.current, { force: true });
      showToast("이후 수정된 셀이 있어 자동 되돌리기를 중단했습니다. 변경 이력을 확인하세요.", "error");
      return;
    }
    if (!response.ok) {
      stateStore.undoStack.length = 0;
      throw new Error(body.detail || `HTTP ${response.status}`);
    }
    body.cells.forEach((cell) => applyCellUpdate(cell, { force: true }));
    showToast(`${body.updated}개 셀을 이전 상태로 되돌렸습니다.`);
  } catch (error) {
    showToast(`되돌리기 실패: ${error.message}`, "error");
  } finally {
    stateStore.undoing = false;
    updateUndoButton();
  }
}

async function clearSelectedCells() {
  const selectedCells = [...stateStore.selected]
    .map(getCellByKey)
    .filter(Boolean);
  if (!selectedCells.length) {
    showToast("먼저 지울 셀을 선택하세요.", "error");
    return;
  }

  const pendingSaves = selectedCells
    .map((cell) => stateStore.pendingSaves.get(cell))
    .filter(Boolean);
  if (pendingSaves.length) await Promise.all(pendingSaves);

  const updates = selectedCells
    .filter((cell) => normalizeCellText(cell) !== "" || (cell.dataset.original || "") !== "")
    .map((cell) => ({
      foup_id: cell.dataset.foup,
      slot_no: Number(cell.dataset.slot),
      column_key: cell.dataset.column,
      value: "",
      expected_version: Number(cell.dataset.version),
    }));

  if (!updates.length) {
    showToast("선택한 셀은 이미 비어 있습니다.");
    return;
  }
  await saveBatch(updates, `${updates.length}개 셀의 내용을 지웠습니다.`, { force: true });
}

function hasTextSelectionInside(cell) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString()) return false;
  return cell.contains(selection.anchorNode) && cell.contains(selection.focusNode);
}

function escapeClipboardHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function selectedRangeMatrix() {
  const selectedCells = [...stateStore.selected]
    .map(getCellByKey)
    .filter(Boolean);
  if (!selectedCells.length) return null;

  const foupIds = new Set(selectedCells.map((cell) => cell.dataset.foup));
  if (foupIds.size !== 1) {
    showToast("복사는 같은 FOUP 안의 셀만 선택할 수 있습니다.", "error");
    return null;
  }

  const foupId = selectedCells[0].dataset.foup;
  const slots = selectedCells.map((cell) => Number(cell.dataset.slot));
  const columns = selectedCells.map((cell) => EDITABLE_COLUMNS.indexOf(cell.dataset.column));
  const minSlot = Math.min(...slots);
  const maxSlot = Math.max(...slots);
  const minColumn = Math.min(...columns);
  const maxColumn = Math.max(...columns);
  const expectedCount = (maxSlot - minSlot + 1) * (maxColumn - minColumn + 1);

  if (expectedCount !== selectedCells.length) {
    showToast("엑셀처럼 연속된 직사각형 범위를 선택해 복사하세요.", "error");
    return null;
  }

  const matrix = [];
  for (let slot = minSlot; slot <= maxSlot; slot += 1) {
    const row = [];
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const key = cellKey(foupId, slot, EDITABLE_COLUMNS[column]);
      if (!stateStore.selected.has(key)) {
        showToast("엑셀처럼 연속된 직사각형 범위를 선택해 복사하세요.", "error");
        return null;
      }
      const cell = getCellByKey(key);
      row.push(cell ? normalizeCellText(cell) : "");
    }
    matrix.push(row);
  }
  return matrix;
}

function copySelectedRange(event) {
  const activeCell = document.activeElement?.closest?.(".editable-cell");
  const browserSelection = window.getSelection();
  if (
    activeCell &&
    browserSelection &&
    !browserSelection.isCollapsed &&
    browserSelection.toString()
  ) {
    return;
  }

  const matrix = selectedRangeMatrix();
  if (!matrix || !event.clipboardData) return;
  event.preventDefault();

  const plainText = matrix.map((row) => row.join("\t")).join("\n");
  const htmlTable = `<table>${matrix
    .map((row) => `<tr>${row.map((value) => `<td>${escapeClipboardHtml(value)}</td>`).join("")}</tr>`)
    .join("")}</table>`;
  event.clipboardData.setData("text/plain", plainText);
  event.clipboardData.setData("text/html", htmlTable);
  showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
}

async function pasteRange(event, startCell) {
  const text = event.clipboardData.getData("text/plain");
  if (!text.includes("\t") && !text.includes("\n") && !text.includes("\r")) return;
  event.preventDefault();
  const rows = text.replace(/\r/g, "").split("\n");
  if (rows.at(-1) === "") rows.pop();
  const startSlot = Number(startCell.dataset.slot);
  const startColumn = EDITABLE_COLUMNS.indexOf(startCell.dataset.column);
  const updates = [];
  let lastCell = startCell;
  rows.forEach((rowText, rowOffset) => {
    rowText.split("\t").forEach((value, columnOffset) => {
      const slot = startSlot + rowOffset;
      const columnIndex = startColumn + columnOffset;
      if (slot > 25 || columnIndex >= EDITABLE_COLUMNS.length) return;
      const target = getCellByKey(cellKey(startCell.dataset.foup, slot, EDITABLE_COLUMNS[columnIndex]));
      if (!target) return;
      updates.push({
        foup_id: target.dataset.foup,
        slot_no: slot,
        column_key: target.dataset.column,
        value,
        expected_version: Number(target.dataset.version),
      });
      lastCell = target;
    });
  });
  const saved = await saveBatch(updates, `${updates.length}개 셀을 붙여넣었습니다.`);
  if (saved) selectRange(cellKey(startCell.dataset.foup, startCell.dataset.slot, startCell.dataset.column), lastCell);
}

function selectedCellForHistory() {
  if (stateStore.selected.size !== 1) return null;
  return getCellByKey([...stateStore.selected][0]);
}

function cellColumnLabel(columnKey) {
  return {
    planned_sub: "Sub",
    assignee: "사용자",
    details: "세부사항",
  }[columnKey] || columnKey;
}

function historyValue(value, color) {
  const wrap = document.createElement("div");
  wrap.className = `cell-history-value ${value ? "" : "cell-history-empty"}`.trim();
  wrap.textContent = value || "빈 셀";
  if (color) {
    wrap.style.borderLeft = `8px solid ${color}`;
    wrap.title = `배경색 ${color}`;
  }
  return wrap;
}

function historyKindLabel(kind) {
  return {
    undo: "되돌리기",
    restore: "이력 복원",
  }[kind] || "수정";
}

function renderCellHistory(data, cell) {
  elements.historyContent.replaceChildren();
  if (!data.items.length) {
    elements.historyContent.appendChild(
      textNode("p", "history-loading", "아직 이 셀의 변경 이력이 없습니다.")
    );
    return;
  }

  const list = document.createElement("div");
  list.className = "cell-history-list";
  data.items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "cell-history-item";

    const meta = document.createElement("div");
    meta.className = "cell-history-meta";
    meta.append(
      textNode("span", "cell-history-actor", `${item.updated_by} · ${historyKindLabel(item.operation_kind)}`),
      textNode("time", "", formatDateTime(item.updated_at))
    );

    const diff = document.createElement("div");
    diff.className = "cell-history-diff";
    diff.append(
      historyValue(item.old_value, item.old_color),
      textNode("span", "cell-history-arrow", "→"),
      historyValue(item.new_value, item.new_color)
    );

    const actions = document.createElement("div");
    actions.className = "cell-history-actions";
    const restore = textNode("button", "restore-button", "변경 전으로 복원");
    restore.type = "button";
    restore.addEventListener("click", () => {
      void restoreCellHistory(cell, item.id, data.current.version, restore);
    });
    actions.appendChild(restore);
    article.append(meta, diff, actions);
    list.appendChild(article);
  });
  elements.historyContent.appendChild(list);
}

async function openCellHistory() {
  const cell = selectedCellForHistory();
  if (!cell) {
    showToast("변경 이력을 볼 셀 하나를 선택하세요.", "error");
    return;
  }
  elements.historyDrawer.classList.add("open");
  elements.historyDrawer.setAttribute("aria-hidden", "false");
  elements.historyEyebrow.textContent = "CELL VERSION";
  elements.historyTitle.textContent = "셀 변경 이력";
  elements.historySubtitle.textContent = `${cell.dataset.foup} · Slot ${cell.dataset.slot} · ${cellColumnLabel(cell.dataset.column)}`;
  elements.historyContent.innerHTML = '<p class="history-loading">변경 이력을 불러오는 중입니다.</p>';
  try {
    const response = await fetch(
      `/api/cells/${encodeURIComponent(cell.dataset.foup)}/${cell.dataset.slot}/${cell.dataset.column}/history`,
      { cache: "no-store" }
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    renderCellHistory(body, cell);
  } catch (error) {
    elements.historyContent.textContent = `변경 이력을 불러오지 못했습니다. ${error.message}`;
  }
}

async function restoreCellHistory(cell, historyId, expectedVersion, button) {
  if (!requireEditorName()) return;
  button.disabled = true;
  try {
    const response = await fetch(
      `/api/cells/${encodeURIComponent(cell.dataset.foup)}/${cell.dataset.slot}/${cell.dataset.column}/history/${historyId}/restore`,
      {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ expected_version: expectedVersion }),
      }
    );
    const body = await response.json();
    if (response.status === 409) {
      applyCellUpdate(body.current, { force: true });
      showToast("이력을 보는 동안 다른 사용자가 수정했습니다. 최신 이력을 다시 확인하세요.", "error");
      await openCellHistory();
      return;
    }
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    applyCellUpdate(body.cell, { force: true });
    rememberOperation(body.operation_id);
    showToast("선택한 변경 전 상태로 복원했습니다.");
    await openCellHistory();
  } catch (error) {
    showToast(`복원 실패: ${error.message}`, "error");
    button.disabled = false;
  }
}

async function openHistory(cell) {
  const { foup, slot, wafer } = cell.dataset;
  elements.historyDrawer.classList.add("open");
  elements.historyDrawer.setAttribute("aria-hidden", "false");
  elements.historyEyebrow.textContent = "WAFER TRACE";
  elements.historyTitle.textContent = "Wafer History";
  elements.historySubtitle.textContent = `${wafer} · ${foup} / Slot ${slot}`;
  elements.historyContent.innerHTML = '<p class="history-loading">이력을 불러오는 중입니다.</p>';
  try {
    const response = await fetch(`/api/foups/${encodeURIComponent(foup)}/slots/${slot}/history`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    renderHistory(body);
  } catch (error) {
    elements.historyContent.textContent = `이력을 불러오지 못했습니다. ${error.message}`;
  }
}

function renderHistory(data) {
  elements.historyContent.replaceChildren();
  if (!data.history || !data.history.length) {
    elements.historyContent.appendChild(textNode("p", "history-loading", "이 Slot에는 현재 Wafer가 없습니다."));
    return;
  }
  const list = document.createElement("ol");
  list.className = "timeline";
  data.history.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = `timeline-item ${index === data.history.length - 1 ? "current" : ""}`;
    li.appendChild(textNode("span", "timeline-dot", ""));
    li.appendChild(textNode("p", "timeline-step", item.step));
    const meta = document.createElement("div");
    meta.className = "timeline-meta";
    meta.append(
      textNode("span", "", formatDateTime(item.timestamp)),
      textNode("span", "", item.tool),
      textNode("span", `result-pill ${item.result === "RUN" ? "run" : ""}`, item.result)
    );
    li.appendChild(meta);
    list.appendChild(li);
  });
  elements.historyContent.appendChild(list);
}

function closeHistory() {
  elements.historyDrawer.classList.remove("open");
  elements.historyDrawer.setAttribute("aria-hidden", "true");
}

function connectWebSocket() {
  window.clearTimeout(stateStore.reconnectTimer);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/updates`);
  socket.addEventListener("open", () => setConnection("online", "실시간 연결"));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "cell_updated") applyCellUpdate(message.cell);
    if (message.type === "cells_updated") message.cells.forEach(applyCellUpdate);
  });
  socket.addEventListener("close", () => {
    setConnection("offline", "재연결 중");
    stateStore.reconnectTimer = window.setTimeout(connectWebSocket, 1800);
  });
  socket.addEventListener("error", () => socket.close());
}

elements.grid.addEventListener("mousedown", (event) => {
  const cell = event.target.closest(".editable-cell");
  if (!cell) return;
  if (event.shiftKey && stateStore.anchor) {
    selectRange(stateStore.anchor, cell, event.metaKey || event.ctrlKey);
  } else if (event.metaKey || event.ctrlKey) {
    toggleSelection(cell);
  } else {
    selectOnly(cell);
  }
  stateStore.dragging = true;
});

elements.grid.addEventListener("mouseover", (event) => {
  if (!stateStore.dragging || !stateStore.anchor) return;
  const cell = event.target.closest(".editable-cell");
  if (cell) selectRange(stateStore.anchor, cell);
});

document.addEventListener("mouseup", () => {
  stateStore.dragging = false;
});

elements.grid.addEventListener("focusin", (event) => {
  const cell = event.target.closest(".editable-cell");
  if (cell) cell.dataset.focusValue = normalizeCellText(cell);
});

elements.grid.addEventListener("focusout", (event) => {
  const cell = event.target.closest(".editable-cell");
  if (cell) void saveCell(cell);
});

elements.grid.addEventListener("keydown", (event) => {
  const waferCell = event.target.closest(".wafer-cell.has-wafer");
  if (waferCell && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    void openHistory(waferCell);
    return;
  }
  const cell = event.target.closest(".editable-cell");
  if (!cell) return;
  const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
  const isDirtySingleCell =
    stateStore.selected.size === 1 && normalizeCellText(cell) !== (cell.dataset.original || "");
  if (isDeleteKey && !hasTextSelectionInside(cell) && !(event.key === "Backspace" && isDirtySingleCell)) {
    event.preventDefault();
    void clearSelectedCells();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cell.textContent = cell.dataset.original || "";
    cell.blur();
  } else if (event.key === "Enter") {
    event.preventDefault();
    void saveCell(cell, { moveAfter: event.shiftKey ? "up" : "down" });
  } else if (event.key === "Tab") {
    event.preventDefault();
    void saveCell(cell, { moveAfter: event.shiftKey ? "left" : "right" });
  }
});

elements.grid.addEventListener("paste", (event) => {
  const cell = event.target.closest(".editable-cell");
  if (cell) void pasteRange(event, cell);
});

document.addEventListener("copy", copySelectedRange);

elements.grid.addEventListener("click", (event) => {
  const waferCell = event.target.closest(".wafer-cell.has-wafer");
  if (waferCell) void openHistory(waferCell);
});

elements.palette.addEventListener("click", (event) => {
  const button = event.target.closest(".color-button");
  if (button) void applyColor(button.dataset.color);
});

elements.search.addEventListener("input", applyFilters);
elements.statusFilter.addEventListener("change", applyFilters);
elements.refresh.addEventListener("click", () => void loadState({ announce: true }));
elements.undo.addEventListener("click", () => void undoLastOperation());
elements.cellHistory.addEventListener("click", () => void openCellHistory());
elements.viewButtons.forEach((button) => {
  button.addEventListener("click", () => setViewMode(button.dataset.view));
});
elements.userName.addEventListener("input", () => {
  if (userName() && userName() !== "익명 사용자") {
    elements.userName.classList.remove("editor-required");
  }
});
elements.userName.addEventListener("change", () => {
  const name = userName();
  if (!name || name === "익명 사용자") {
    elements.userName.value = "";
    localStorage.removeItem("foup-user-name");
    return;
  }
  localStorage.setItem("foup-user-name", name);
  elements.userName.value = name;
  elements.userName.classList.remove("editor-required");
  const waitingCells = [...stateStore.waitingForEditor];
  stateStore.waitingForEditor.clear();
  waitingCells.forEach((cell) => void saveCell(cell));
});
elements.userName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    elements.userName.blur();
  }
});

document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closeHistory));
document.addEventListener("keydown", (event) => {
  const undoShortcut =
    (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLocaleLowerCase() === "z";
  if (undoShortcut) {
    const target = event.target;
    if (target.matches?.("input, textarea, select")) return;
    const activeCell = target.closest?.(".editable-cell");
    const pendingSave = activeCell ? stateStore.pendingSaves.get(activeCell) : null;
    if (
      activeCell &&
      !pendingSave &&
      normalizeCellText(activeCell) !== (activeCell.dataset.original || "")
    ) return;
    event.preventDefault();
    void undoLastOperation({ pendingSave });
    return;
  }
  if (event.key === "Escape" && elements.historyDrawer.classList.contains("open")) closeHistory();
});

const savedUserName = localStorage.getItem("foup-user-name") || "";
elements.userName.value = savedUserName === "익명 사용자" ? "" : savedUserName;
if (savedUserName === "익명 사용자") localStorage.removeItem("foup-user-name");
setViewMode(stateStore.viewMode);
updateUndoButton();
void loadState();
connectWebSocket();
