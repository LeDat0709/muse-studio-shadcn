"use strict";

(() => {
  const state = {
    status: null,
    accounts: [],
    batchRows: [],
    promptMode: "single",
    previewRowId: "",
    queueFilter: { q: "", status: "all" },
    queueView: ["grid", "table"].includes(localStorage.getItem("muse_queue_view")) ? localStorage.getItem("muse_queue_view") : "list",
    media: [],
    tasks: [],
    logs: [],
    zoom: Number(localStorage.getItem("embong_zoom") || 100),
    theme: localStorage.getItem("embong_theme") || "dark",
    pendingImageRowId: null,
    pendingCharacterTarget: null, // "bulk" | "script" | rowId
    pendingProductTarget: null, // "bulk" | "script" | rowId
    bulkCharacterImage: null,
    bulkProductImage: null,
    bulkProductImages: [],
    scriptCharacterImage: null,
    scriptProductImage: null,
    scriptProductImages: [],
    batchRunning: false,
  };

  const DURATION_OPTIONS = ["5s", "6s", "8s", "10s", "15s", "20s", "30s", "40s", "50s", "60s"];
  const QUALITY_OPTIONS = ["1K", "2K", "4K"];

  const DEFAULT_FIXED_VIDEO_PROMPT =
    "Khung hình dọc 9:16. Nhà xưởng công nghiệp rộng, trần cao, mái và tường tôn xám, dầm thép tối màu, sàn bê tông. Chuyển động camera mượt mà quay cận cảnh và xoay quanh sản phẩm trong không gian nhà xưởng công nghiệp sáng rõ, giữ nguyên thiết kế và chi tiết sản phẩm mẫu đính kèm, chất lượng 4K sắc nét.";

  const ICON = {
    sun: `<svg aria-hidden="true" class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
    moon: `<svg aria-hidden="true" class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`,
    eye: `<svg aria-hidden="true" class="lucide" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg aria-hidden="true" class="lucide" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`,
    plus: `<svg aria-hidden="true" class="lucide" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
    upload: `<svg aria-hidden="true" class="lucide" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
    clapperboard: `<svg aria-hidden="true" class="lucide" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
    userPlus: `<svg aria-hidden="true" class="lucide" width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`,
    packagePlus: `<svg aria-hidden="true" class="lucide" width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16h6"/><path d="M19 13v6"/><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/></svg>`,
    image: `<svg aria-hidden="true" class="lucide" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
    play: `<svg aria-hidden="true" class="lucide" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
    pause: `<svg aria-hidden="true" class="lucide" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>`,
    trash: `<svg aria-hidden="true" class="lucide" width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    search: `<svg aria-hidden="true" class="lucide" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    download: `<svg aria-hidden="true" class="lucide" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
    globe: `<svg aria-hidden="true" class="lucide" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
    refresh: `<svg aria-hidden="true" class="lucide" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`,
    barChart: `<svg aria-hidden="true" class="lucide" width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>`,
    sparkles: `<svg aria-hidden="true" class="lucide" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`,
    check: `<svg aria-hidden="true" class="lucide" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    alert: `<svg aria-hidden="true" class="lucide" width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`,
    spinner: `<svg aria-hidden="true" class="lucide spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    stop: `<svg aria-hidden="true" class="lucide" width="11.5" height="11.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`,
    edit: `<svg aria-hidden="true" class="lucide" width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
  };

  function $(sel) {
    return document.querySelector(sel);
  }

  function $all(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  function showToast(msg, isError = false) {
    const container = $("#toastContainer");
    if (!container) return;
    const cleanMsg = String(msg || "").replace(/^[\u{1F300}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\uFE0F\s]+/u, "").trim();
    const el = document.createElement("div");
    el.className = `toast${isError ? " error" : ""}`;
    el.innerHTML = `${isError ? ICON.alert : ICON.check}<span>${escapeHtml(cleanMsg || msg)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3800);
  }

  async function api(url, options = {}) {
    const opts = {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    };
    if (options.body !== undefined) {
      opts.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function uid() {
    return "row_" + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTimeAgo(tsSec) {
    if (!tsSec) return "Chưa từng";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(tsSec));
    if (diff < 60) return `${diff}s trước`;
    if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
    return `${Math.floor(diff / 86400)} ngày trước`;
  }

  const PROMPT_SINGLE_KEY = "embong_fixed_video_prompt";
  const PROMPT_LINES_KEY = "muse_prompt_lines";
  const PROMPT_MODE_KEY = "muse_prompt_mode";

  function getFixedVideoPrompt() {
    const el = $("#bulkVideoPromptsInput");
    if (state.promptMode === "lines") {
      // Rows made outside the list (a product, "Thêm 1 luồng") take the list's first prompt.
      const lines = window.MusePromptLines.splitPromptLines(el ? el.value : "");
      return lines[0] || String(localStorage.getItem(PROMPT_SINGLE_KEY) || "").trim();
    }
    return String(el ? el.value : localStorage.getItem(PROMPT_SINGLE_KEY) || "").trim();
  }

  function promptRepeat() {
    return Math.max(1, Math.min(10, Number($("#promptRepeatInput")?.value) || 1));
  }

  function updatePromptHint() {
    const hint = $("#promptHint");
    const label = $("#btnCreateStreamsLabel");
    if (state.promptMode !== "lines") {
      if (hint) hint.textContent = "Áp dụng cho mọi luồng chưa chạy, tự lưu khi gõ.";
      if (label) label.textContent = "Chỉ thêm vào hàng đợi";
      return;
    }
    const count = window.MusePromptLines.splitPromptLines($("#bulkVideoPromptsInput")?.value).length;
    const repeat = promptRepeat();
    const total = count * repeat;
    if (hint) {
      hint.textContent =
        count === 0
          ? "Chưa có prompt nào. Mỗi dòng sẽ thành một luồng."
          : repeat > 1
          ? `${count} prompt, lặp ${repeat} lần: ${total} luồng`
          : `${count} prompt: ${count} luồng`;
    }
    if (label) label.textContent = total > 0 ? `Thêm ${total} luồng vào hàng đợi` : "Thêm vào hàng đợi";
  }

  // Each mode keeps its own text: one shared prompt, or a list with one prompt per line.
  function applyPromptMode() {
    const isLines = state.promptMode === "lines";
    const input = $("#bulkVideoPromptsInput");
    if ($("#promptModeLines")) $("#promptModeLines").checked = isLines;
    if ($("#promptModeSingle")) $("#promptModeSingle").checked = !isLines;
    if (input) {
      input.value = isLines
        ? localStorage.getItem(PROMPT_LINES_KEY) || ""
        : localStorage.getItem(PROMPT_SINGLE_KEY) || DEFAULT_FIXED_VIDEO_PROMPT;
      input.classList.toggle("is-lines", isLines);
      input.placeholder = isLines
        ? "Mỗi dòng một prompt, ví dụ:\nTách cà phê bốc khói trên bàn gỗ\nẤm trà bên cửa sổ lúc bình minh"
        : "Nhập prompt dùng chung cho mọi luồng…";
    }
    if ($("#promptStreamCountWrap")) $("#promptStreamCountWrap").hidden = isLines;
    if ($("#promptRepeatWrap")) $("#promptRepeatWrap").hidden = !isLines;
    if ($("#btnAddOneStream")) $("#btnAddOneStream").hidden = isLines;
    updatePromptHint();
  }

  // AI scripts arrive as a list: the list mode keeps one prompt per line, the single mode joins them.
  function loadPromptsIntoInput(lines) {
    const isLines = state.promptMode === "lines";
    const text = lines.join(isLines ? "\n" : " ");
    if ($("#bulkVideoPromptsInput")) $("#bulkVideoPromptsInput").value = text;
    localStorage.setItem(isLines ? PROMPT_LINES_KEY : PROMPT_SINGLE_KEY, text);
    updatePromptHint();
  }

  function initFixedPrompts() {
    const savedVid = localStorage.getItem(PROMPT_SINGLE_KEY);
    if (!savedVid || !savedVid.trim()) {
      localStorage.setItem(PROMPT_SINGLE_KEY, DEFAULT_FIXED_VIDEO_PROMPT);
    }
    state.promptMode = localStorage.getItem(PROMPT_MODE_KEY) === "lines" ? "lines" : "single";
    applyPromptMode();
  }

  // One table row built from the current bulk settings (mode, ratio, duration, quality, account, character).
  function newBatchRow(prompt) {
    const bulkMode = $("#bulkModeSelect")?.value || "video";
    const streamIndex = state.batchRows.length + 1;
    const rowId = uid();
    const charImg = state.bulkCharacterImage;
    return {
      id: rowId,
      selected: true,
      mode: bulkMode,
      stepOrder: bulkMode === "image" ? 1 : 2,
      streamIndex,
      streamId: `stream_${bulkMode}_${streamIndex}_${rowId}`,
      streamLabel: `Luồng ${bulkMode === "image" ? "Ảnh" : "Video"} #${streamIndex}`,
      prompt,
      aspectRatio: $("#bulkAspectSelect")?.value || "9:16",
      duration: $("#bulkDurationSelect")?.value || "20s",
      quality: $("#bulkQualitySelect")?.value || "4K",
      characterImage: charImg ? { ...charImg } : null,
      productImage: null,
      referenceImage: null,
      accountId: $("#bulkAccountSelect")?.value || "",
      accountName: "",
      status: "idle",
      error: "",
      mediaUrl: "",
      filename: "",
    };
  }

  function addRowsFromPromptLines() {
    const prompts = window.MusePromptLines.splitPromptLines($("#bulkVideoPromptsInput")?.value);
    if (!prompts.length) {
      showToast("Nhập ít nhất một prompt, mỗi dòng một prompt.", true);
      $("#bulkVideoPromptsInput")?.focus();
      return 0;
    }
    const repeat = promptRepeat();
    for (const prompt of prompts) {
      for (let i = 0; i < repeat; i += 1) state.batchRows.push(newBatchRow(prompt));
    }
    renderProductChips();
    saveBatchRows();
    renderBatchTable();
    showToast(`Đã thêm ${prompts.length * repeat} luồng vào bảng (${prompts.length} prompt).`);
    return prompts.length * repeat;
  }

  const activeClientRowIds = new Set();

  function syncProductChipsFromRows() {
    const prodList = [];
    state.batchRows.forEach((r, idx) => {
      r.streamIndex = idx + 1;
      if (!r.streamId) r.streamId = `stream_${r.id}`;
      const shortName = r.productImage?.name
        ? r.productImage.name.replace(/\.[^.]+$/, "").slice(0, 14)
        : "";
      r.streamLabel = r.productImage
        ? `Luồng SP #${idx + 1}${shortName ? ` (${shortName})` : ""}`
        : `Luồng Video #${idx + 1}`;
      if (r.productImage && (r.productImage.b64 || r.productImage.dataUrl)) {
        prodList.push({
          ...r.productImage,
          id: r.streamId,
          rowId: r.id,
          streamIndex: idx + 1,
        });
      }
    });
    state.bulkProductImages = prodList;
    state.bulkProductImage = prodList[0] || null;
  }

  function renderProductChips() {
    syncProductChipsFromRows();
    const bulkBox = $("#bulkProductListBox");
    const bulkClearBtn = $("#btnClearBulkProduct");
    const badge = $("#bulkProductCountBadge");
    const bulkList = state.bulkProductImages || [];
    const totalRows = state.batchRows.length;

    if (badge) {
      const spCount = bulkList.length;
      badge.innerHTML = `${spCount} SP (${totalRows || spCount} luồng) · &gt;10s tự ghép`;
    }
    if (bulkClearBtn) {
      bulkClearBtn.style.display = bulkList.length > 0 || totalRows > 0 ? "inline-flex" : "none";
    }
    if (bulkBox) {
      bulkBox.innerHTML = bulkList
        .map(
          (p, i) => `
          <span class="product-chip" title="Luồng SP #${p.streamIndex || i + 1}: ${escapeHtml(p.name)}">
            <img src="${p.dataUrl}" alt="" />
            <span>SP#${p.streamIndex || i + 1}</span>
            <button type="button" class="product-chip-remove" data-remove-bulk-row="${escapeHtml(p.rowId || "")}" data-remove-bulk-prod="${i}" title="Bỏ Luồng SP #${p.streamIndex || i + 1}">×</button>
          </span>`
        )
        .join("");
    }

    const scriptBox = $("#scriptProductListBox");
    const scriptClearBtn = $("#btnClearScriptProduct");
    const scriptList = state.scriptProductImages || [];
    state.scriptProductImage = scriptList[0] || null;

    if (scriptClearBtn) {
      scriptClearBtn.style.display = scriptList.length > 0 ? "inline-flex" : "none";
    }
    if (scriptBox) {
      scriptBox.innerHTML = scriptList
        .map(
          (p, i) => `
          <span class="product-chip" title="Luồng SP #${i + 1}: ${escapeHtml(p.name)}">
            <img src="${p.dataUrl}" alt="" />
            <span>SP#${i + 1}</span>
            <button type="button" class="product-chip-remove" data-remove-script-prod="${i}" title="Bỏ SP #${i + 1}">×</button>
          </span>`
        )
        .join("");
    }
  }

  /**
   * Updates non-running rows in place when bulk settings (Prompt, Aspect Ratio, Duration, Quality, Account, Character) change,
   * WITHOUT ever deleting or overwriting existing streams in `state.batchRows`.
   */
  function syncStreamsFromProducts({ preserveFinished = true, clearIfEmpty = false } = {}) {
    const fixedVidPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
    const bulkMode = $("#bulkModeSelect")?.value || "video";
    const aspectRatio = $("#bulkAspectSelect")?.value || "9:16";
    const duration = $("#bulkDurationSelect")?.value || "20s";
    const quality = $("#bulkQualitySelect")?.value || "4K";
    const accountId = $("#bulkAccountSelect")?.value || "";
    const accObj = state.accounts.find((a) => a.id === accountId);
    const accountName = accObj ? accObj.name : "";
    const charImg = state.bulkCharacterImage;

    if (clearIfEmpty && state.batchRows.length === 0) {
      scheduleSaveBatchRows();
      renderBatchTable();
      return;
    }

    for (const r of state.batchRows) {
      const isBusyOrDone =
        r.status === "running" ||
        activeClientRowIds.has(r.id) ||
        (preserveFinished && r.status === "done");
      if (!isBusyOrDone) {
        r.mode = bulkMode;
        // In the list mode every row keeps its own prompt; settings changes must not overwrite it.
        if (state.promptMode !== "lines") r.prompt = fixedVidPrompt;
        r.aspectRatio = aspectRatio;
        r.duration = duration;
        r.quality = quality;
        if (accountId !== undefined) {
          r.accountId = accountId;
          if (accountName) r.accountName = accountName;
        }
        if (charImg) {
          r.characterImage = { ...charImg };
        }
      }
    }

    const totalStreams = state.batchRows.length;
    if (totalStreams > 0 && $("#promptStreamCountInput")) {
      $("#promptStreamCountInput").value = String(totalStreams);
    }

    renderProductChips();
    scheduleSaveBatchRows();
    renderBatchTable();
  }

  function createStreamsFromPrompt(requestedCount) {
    const fixedVidPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
    if (!fixedVidPrompt.trim()) {
      showToast("Vui lòng nhập nội dung Prompt Tạo Video trước khi tạo luồng!", true);
      $("#bulkVideoPromptsInput")?.focus();
      return;
    }

    const countInputVal = Number($("#promptStreamCountInput")?.value || 3);
    const targetCount = Math.max(
      1,
      Math.min(20, Number(requestedCount || countInputVal || 3))
    );
    const bulkMode = $("#bulkModeSelect")?.value || "video";
    const aspectRatio = $("#bulkAspectSelect")?.value || "9:16";
    const duration = $("#bulkDurationSelect")?.value || "20s";
    const quality = $("#bulkQualitySelect")?.value || "4K";
    const accountId = $("#bulkAccountSelect")?.value || "";
    const charImg = state.bulkCharacterImage;

    for (const r of state.batchRows) {
      if (r.status !== "running" && !activeClientRowIds.has(r.id) && r.status !== "done") {
        r.mode = bulkMode;
        r.prompt = fixedVidPrompt;
        r.aspectRatio = aspectRatio;
        r.duration = duration;
        r.quality = quality;
        if (charImg) r.characterImage = { ...charImg };
        if (accountId) r.accountId = accountId;
      }
    }

    const needed =
      state.batchRows.length === 0
        ? targetCount
        : Math.max(0, targetCount - state.batchRows.length);
    const toAdd = needed > 0 ? needed : requestedCount ? Number(requestedCount) : 0;

    for (let i = 0; i < toAdd; i += 1) {
      state.batchRows.push(newBatchRow(fixedVidPrompt));
    }

    const totalStreams = state.batchRows.length;
    if ($("#promptStreamCountInput")) {
      $("#promptStreamCountInput").value = String(totalStreams);
    }

    renderProductChips();
    saveBatchRows();
    renderBatchTable();
    showToast(
      `Đã sẵn sàng ${totalStreams} Luồng Video từ Prompt cố định!`
    );
  }

  function addOneStreamFromPrompt({ focusPreview = false } = {}) {
    const fixedVidPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
    const streamIndex = state.batchRows.length + 1;
    const createdRow = newBatchRow(fixedVidPrompt);
    state.batchRows.push(createdRow);
    state.previewRowId = createdRow.id;

    if ($("#promptStreamCountInput")) {
      $("#promptStreamCountInput").value = String(state.batchRows.length);
    }

    renderProductChips();
    saveBatchRows();
    renderBatchTable();
    if (focusPreview) {
      const promptEl = $("#previewPrompt");
      if (promptEl) {
        promptEl.focus();
        promptEl.select();
      }
    }
    showToast(`Đã thêm Luồng #${streamIndex} vào hàng đợi!`);
  }

  function sortBatchRowsByStream() {
    state.batchRows.forEach((r, idx) => {
      if (r.mode !== "image" && r.mode !== "video") r.mode = "video";
      r.stepOrder = r.mode === "image" ? 1 : 2;
      r.streamIndex = idx + 1;
      if (!r.streamId) r.streamId = `stream_${r.id}`;
      const shortName = r.productImage?.name
        ? r.productImage.name.replace(/\.[^.]+$/, "").slice(0, 14)
        : "";
      const prefix = r.mode === "image" ? "Ảnh" : "Video";
      r.streamLabel = r.productImage
        ? `SP #${idx + 1}${shortName ? ` (${shortName})` : ""}`
        : `Luồng ${prefix} #${idx + 1}`;
    });
  }

  // ==================== THEME & ZOOM ====================
  function applyTheme(theme) {
    state.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", state.theme);
    localStorage.setItem("embong_theme", state.theme);
    const icon = $("#themeIcon");
    const label = $("#themeLabel");
    if (state.theme === "dark") {
      if (icon) icon.innerHTML = ICON.sun;
      if (label) label.textContent = "Giao diện Sáng";
    } else {
      if (icon) icon.innerHTML = ICON.moon;
      if (label) label.textContent = "Giao diện Tối";
    }
  }

  function applyZoom(zoomVal) {
    state.zoom = Math.min(140, Math.max(65, Math.round(Number(zoomVal) || 100)));
    localStorage.setItem("embong_zoom", String(state.zoom));
    const factor = state.zoom / 100;

    if (window.embongDesktop && typeof window.embongDesktop.setZoomFactor === "function") {
      // Native Electron full-window zoom: scales 100vw & 100vh edge-to-edge without gaps or clipping
      document.body.style.zoom = "";
      document.documentElement.style.setProperty("--app-zoom", "1");
      window.embongDesktop.setZoomFactor(factor);
    } else {
      // Browser fallback: scale both body zoom and inverse viewport calc(--app-zoom)
      document.documentElement.style.setProperty("--app-zoom", String(factor));
      document.body.style.zoom = `${state.zoom}%`;
    }

    const txt = $("#zoomValueText");
    if (txt) txt.textContent = `${state.zoom}%`;
  }

  function updateChromeVisibilityButtons(isVisible) {
    const showTop = $("#btnShowChromeWindow");
    const hideTop = $("#btnHideChromeWindow");
    const showSide = $("#btnSideShowChrome");
    const hideSide = $("#btnSideHideChrome");

    if (isVisible === false) {
      if (hideTop) {
        hideTop.classList.add("btn-brand");
        hideTop.innerHTML = `${ICON.eyeOff}<span>Headless 100% (Đang bật)</span>`;
      }
      if (showTop) {
        showTop.classList.remove("btn-primary");
        showTop.innerHTML = `${ICON.eye}<span>Hiện Chrome (Gọn)</span>`;
      }
      if (hideSide) {
        hideSide.classList.add("btn-brand");
        hideSide.innerHTML = `${ICON.eyeOff}<span>Headless</span>`;
      }
      if (showSide) showSide.innerHTML = `${ICON.eye}<span>Hiện Chrome</span>`;
    } else {
      if (hideTop) {
        hideTop.classList.remove("btn-brand");
        hideTop.innerHTML = `${ICON.eyeOff}<span>Chạy Headless (Ẩn)</span>`;
      }
      if (showTop) {
        showTop.innerHTML = `${ICON.eye}<span>Hiện Chrome (Gọn)</span>`;
      }
      if (hideSide) {
        hideSide.classList.remove("btn-brand");
        hideSide.innerHTML = `${ICON.eyeOff}<span>Headless</span>`;
      }
      if (showSide) showSide.innerHTML = `${ICON.eye}<span>Hiện Chrome</span>`;
    }
  }

  function buildCompactRunningBadgeParts(row) {
    const pct = Math.min(99, Math.max(5, Number(row.progressPct) || 15));
    const rawTxt = String(row.progressText || "Đang xử lý qua cổng HTTP + Noise-XX Gateway...");
    const secMatch = rawTxt.match(/\((\d+s)\)/);
    const elapsedPart = secMatch ? ` (${secMatch[1]})` : "";

    let shortLabel = "Đang tạo";
    if (/xác thực|kết nối|gateway|noise/i.test(rawTxt)) shortLabel = "Kết nối VM";
    else if (/tải.*ảnh|tham chiếu|upload/i.test(rawTxt)) shortLabel = "Nạp ảnh";
    else if (/gửi lệnh|nhập prompt/i.test(rawTxt)) shortLabel = "Gửi lệnh";
    else if (/ghép|stitch|ffmpeg|nối/i.test(rawTxt)) shortLabel = "Ghép video";
    else if (/tải.*file|tải trực tiếp|lưu/i.test(rawTxt)) shortLabel = "Tải MP4";
    else if (/phân cảnh|render|tạo video/i.test(rawTxt)) shortLabel = "Tạo cảnh";

    return {
      pct,
      shortText: `${pct}%, ${shortLabel}${elapsedPart}`,
      fullTitle: `${pct}% — ${rawTxt}`,
    };
  }

  // ==================== NAVIGATION ====================
  function switchView(viewName) {
    $all(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
    $all(".view-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `view-${viewName}`);
    });
    if (viewName === "media") loadMedia();
    if (viewName === "tasks") loadTasksAndLogs();
    if (viewName === "accounts") loadAccounts();
  }

  // ==================== STATUS & ACCOUNTS ====================
  async function loadStatus() {
    try {
      const data = await api("/admin/status");
      state.status = data;

      const baseUrlV1 = `${data.base_url}/v1`;
      if ($("#sideBaseUrlText")) $("#sideBaseUrlText").textContent = baseUrlV1;
      if ($("#apiBaseUrlInput")) $("#apiBaseUrlInput").value = baseUrlV1;
      if ($("#apiKeyInput")) $("#apiKeyInput").value = data.api_key || "";

      const cdpEl = $("#sideCdpStatus");
      if (cdpEl) {
        cdpEl.innerHTML = `<span class="status-dot"></span>HTTP + Noise-XX (No CDP)`;
      }

      if ($("#sideActiveAccounts")) {
        $("#sideActiveAccounts").textContent = `${data.stats.accounts.live ?? data.stats.accounts.active} / ${data.stats.accounts.total} ních`;
      }
      if ($("#sideRunningTasks")) {
        $("#sideRunningTasks").textContent = `${data.active_tasks || 0} luồng`;
      }
      if ($("#navBadgeAccounts")) {
        $("#navBadgeAccounts").textContent = String(
          data.stats.accounts.live ?? data.stats.accounts.active
        );
      }
      if ($("#navBadgeMedia")) {
        $("#navBadgeMedia").textContent = String(data.stats.media_count || 0);
      }
      if ($("#navBadgeTasks")) {
        $("#navBadgeTasks").textContent = String(data.stats.tasks.total || 0);
      }

      if (data.stats && data.stats.accounts) {
        const localLive = state.accounts.filter(
          (a) => a.status === "live" || a.status === "active"
        ).length;
        if (
          data.stats.accounts.total !== state.accounts.length ||
          data.stats.accounts.active !== localLive
        ) {
          loadAccounts();
        }
      }

      // Update live progress for each running batch row (matched accurately by row_id!)
      if (Array.isArray(data.running_tasks) && data.running_tasks.length > 0) {
        let changed = false;
        const usedRowIds = new Set();
        for (const rt of data.running_tasks) {
          let matchingRow = null;
          if (rt.row_id) {
            matchingRow = state.batchRows.find((r) => r.id === rt.row_id);
          }
          if (!matchingRow) {
            matchingRow = state.batchRows.find(
              (r) =>
                r.status === "running" &&
                !usedRowIds.has(r.id) &&
                !r.jobId &&
                r.prompt &&
                rt.prompt &&
                rt.prompt.trim() === r.prompt.trim()
            );
          }
          if (matchingRow && matchingRow.status === "running" && !matchingRow.cancelledByUser) {
            usedRowIds.add(matchingRow.id);
            matchingRow.progressPct = rt.progress || 15;
            matchingRow.progressText = rt.progress_text || "Đang xử lý trên cổng Gateway...";
            changed = true;
          }
        }
        if (changed) {
          updateRunningRowBadgesInDom();
        }
      } else if (Number(data.active_tasks || 0) === 0) {
        // Recover any stale "running" row that is no longer active on client or server
        let recovered = false;
        for (const r of state.batchRows) {
          if (r.status === "running" && !activeClientRowIds.has(r.id)) {
            r.status = r.mediaUrl ? "done" : "idle";
            recovered = true;
          }
        }
        if (recovered) {
          saveBatchRows();
          renderBatchTable();
        }
      }

      if (data.settings) {
        if ($("#setMaxConcurrency") && document.activeElement !== $("#setMaxConcurrency"))
          $("#setMaxConcurrency").value = data.settings.maxConcurrency || 3;
        if ($("#setKeepaliveMin") && document.activeElement !== $("#setKeepaliveMin"))
          $("#setKeepaliveMin").value = data.settings.keepaliveIntervalMinutes || 360;
        if ($("#setGenTimeout") && document.activeElement !== $("#setGenTimeout"))
          $("#setGenTimeout").value = data.settings.genTimeout || 180;
        if ($("#setVideoTimeout") && document.activeElement !== $("#setVideoTimeout"))
          $("#setVideoTimeout").value = data.settings.videoTimeout || 600;
        if (
          data.settings.geminiApiKey &&
          $("#scriptGeminiKeyInput") &&
          !$("#scriptGeminiKeyInput").value &&
          document.activeElement !== $("#scriptGeminiKeyInput")
        ) {
          $("#scriptGeminiKeyInput").value = data.settings.geminiApiKey;
        }
        if (
          data.settings.geminiApiKey &&
          $("#setGeminiApiKey") &&
          !$("#setGeminiApiKey").value &&
          document.activeElement !== $("#setGeminiApiKey")
        ) {
          $("#setGeminiApiKey").value = data.settings.geminiApiKey;
        }
        if (
          data.settings.geminiModel &&
          $("#scriptGeminiModelSelect") &&
          document.activeElement !== $("#scriptGeminiModelSelect")
        ) {
          $("#scriptGeminiModelSelect").value = data.settings.geminiModel;
        }
      }

      renderApiExamples(baseUrlV1, data.api_key);
    } catch (_err) {
      // ignore
    }
  }

  function updateRunningRowBadgesInDom() {
    for (const row of state.batchRows) {
      if (row.status === "running") {
        const wrapEl = document.querySelector(`[data-row-status-id="${row.id}"]`);
        if (wrapEl) {
          const { pct, shortText, fullTitle } = buildCompactRunningBadgeParts(row);
          wrapEl.title = fullTitle;
          const badgeSpan = wrapEl.querySelector(".badge-running");
          if (badgeSpan) badgeSpan.textContent = shortText;
          const barFill = wrapEl.querySelector(".mini-progress-fill");
          if (barFill) barFill.style.width = `${pct}%`;
        }
      }
    }
  }

  function renderApiExamples(baseUrlV1, apiKey) {
    const box = $("#apiCodeExamplesBox");
    if (!box) return;
    box.textContent = `# 1. Chat / Viết code với Muse-Spark (Chuẩn OpenAI SDK)
curl ${baseUrlV1}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "muse-spark",
    "messages": [{"role": "user", "content": "Viết kịch bản 5 cảnh TikTok về cà phê Việt Nam"}],
    "stream": true
  }'

# 2. Tạo Ảnh AI (muse-image / dall-e-3) hỗ trợ 1K / 2K / 4K
curl ${baseUrlV1}/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "muse-image",
    "prompt": "Poster trà sữa kem cheese ánh sáng studio 4K",
    "aspect_ratio": "9:16",
    "quality": "4K"
  }'

# 3. Tạo Video AI (muse-video / sora / veo-3) hỗ trợ 20s / 30s / 40s / 50s & 1K/2K/4K
curl ${baseUrlV1}/videos \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "muse-video",
    "prompt": "Flycam ruộng bậc thang Mù Cang Chải mùa lúa chín vàng óng",
    "aspect_ratio": "9:16",
    "duration": "20s",
    "quality": "4K"
  }'`;
  }

  async function loadAccounts() {
    try {
      const data = await api("/admin/accounts");
      state.accounts = data.accounts || [];
      renderAccountsTable();
      populateAccountSelects();
    } catch (err) {
      showToast(`Lỗi tải danh sách ních: ${err.message}`, true);
    }
  }

  function populateAccountSelects() {
    const sel = $("#bulkAccountSelect");
    if (!sel) return;
    const cur = sel.value;
    const opts = [`<option value="">Xoay vòng ních LIVE</option>`];
    for (const acc of state.accounts) {
      if (acc.status === "live" || acc.status === "active") {
        opts.push(
          `<option value="${escapeHtml(acc.id)}">${escapeHtml(acc.name)} (${acc.use_count || 0})</option>`
        );
      }
    }
    sel.innerHTML = opts.join("");
    sel.value = cur;
  }

  function renderAccountsTable() {
    const tbody = $("#accountsTableBody");
    if (!tbody) return;

    const liveCount = state.accounts.filter(
      (a) => a.status === "live" || a.status === "active"
    ).length;
    const dieCount = state.accounts.filter(
      (a) => a.status === "die" || a.status === "invalid"
    ).length;
    if ($("#accStatActive")) $("#accStatActive").textContent = String(liveCount);
    if ($("#accStatTotal")) $("#accStatTotal").textContent = String(state.accounts.length);
    if ($("#accStatInvalid")) $("#accStatInvalid").textContent = String(dieCount);
    if ($("#navBadgeAccounts")) $("#navBadgeAccounts").textContent = String(liveCount);

    if (!state.accounts.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center; padding: 36px; color: var(--muted-foreground)">
            Chưa có tài khoản Muse.ai nào. Hãy bấm nút
            <strong style="color: var(--foreground)">Mở Chrome đăng nhập (Tự lấy Cookie)</strong>
            ở góc trên hoặc dán Cookie vào ô bên trên.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = state.accounts
      .map((acc) => {
        let statusBadge = `<span class="badge badge-warn">Chưa Check Live</span>`;
        if (acc.status === "live") {
          statusBadge = `<span class="badge badge-ok">${ICON.check}<span>LIVE</span></span>`;
        } else if (acc.status === "disabled") {
          statusBadge = `<span class="badge badge-idle">Tạm dừng</span>`;
        } else if (acc.status === "die" || acc.status === "invalid") {
          statusBadge = `<span class="badge badge-fail" title="${escapeHtml(acc.last_error)}">${ICON.alert}<span>DIE</span></span>`;
        }

        let expHtml = `<span class="badge badge-idle">Không rõ</span>`;
        if (acc.expires_in_hours !== null && acc.expires_in_hours !== undefined) {
          if (acc.expires_in_hours <= 0) {
            expHtml = `<span class="badge badge-fail">Đã hết hạn</span>`;
          } else if (acc.expires_in_hours < 12) {
            expHtml = `<span class="badge badge-warn">Còn ${acc.expires_in_hours}h</span>`;
          } else {
            expHtml = `<span class="badge badge-ok">Còn ${acc.expires_in_hours}h</span>`;
          }
        }

        const quotaPct = acc.quota?.used_percent || "Chưa đo";
        const errLine =
          (acc.status === "die" || acc.status === "invalid" || acc.last_error) && acc.last_error
            ? `<div style="font-size:11px; color:var(--danger); margin-top:3px; max-width:260px">${escapeHtml(acc.last_error)}</div>`
            : acc.vm_state
            ? `<div style="font-size:11px; color:var(--accent-strong); margin-top:2px">VM: ${escapeHtml(acc.vm_state)}</div>`
            : "";

        const portNum = acc.cdp_port || 9225;
        return `
          <tr>
            <td>
              <code>${escapeHtml(acc.id)}</code>
              <div style="font-size:10.5px; color:var(--accent-strong); margin-top:2px" title="Profile Chrome độc lập của ních này (Cổng CDP :${portNum})">CDP :${portNum}</div>
            </td>
            <td>
              <strong>${escapeHtml(acc.name)}</strong>
              ${acc.email ? `<div style="font-size:11px;color:var(--muted-foreground)">${escapeHtml(acc.email)}</div>` : ""}
            </td>
            <td>
              ${statusBadge}
              ${errLine}
            </td>
            <td>${acc.cookie_count} cookies ${acc.has_session ? "đủ hatch_sess" : "Thiếu hatch_sess"}</td>
            <td>${expHtml}</td>
            <td><span class="badge badge-idle">${escapeHtml(quotaPct)}</span></td>
            <td>${acc.use_count || 0} lượt / ${acc.fail_count || 0} lỗi</td>
            <td>${formatTimeAgo(acc.last_keepalive)}</td>
            <td>
              <div style="display:flex; gap:5px; flex-wrap:wrap">
                <button class="btn btn-primary btn-sm" data-acc-action="open-chrome" data-id="${escapeHtml(acc.id)}" title="Mở cửa sổ Chrome riêng của ních này (Cổng :${portNum})">${ICON.globe}<span>Mở Chrome</span></button>
                <button class="btn btn-soft btn-sm" data-acc-action="renew" data-id="${escapeHtml(acc.id)}" title="Mở Chrome kiểm tra LIVE / DIE và gia hạn 48h">${ICON.refresh}<span>Check Live</span></button>
                <button class="btn btn-sm" data-acc-action="quota" data-id="${escapeHtml(acc.id)}" title="Kiểm tra Quota">${ICON.barChart}<span>Quota</span></button>
                <button class="btn btn-sm" data-acc-action="toggle" data-id="${escapeHtml(acc.id)}">${acc.status === "disabled" ? ICON.play : ICON.pause}</button>
                <button class="btn btn-danger btn-sm" data-acc-action="delete" data-id="${escapeHtml(acc.id)}">${ICON.trash}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  // ==================== BATCH PRODUCTION TABLE ====================
  async function loadBatchRows() {
    try {
      const data = await api("/admin/batch-rows");
      const savedRows = Array.isArray(data.rows) ? data.rows : [];

      if (savedRows.length > 0) {
        let hadInvalidStatus = false;
        state.batchRows = savedRows.map((r) => {
          const isStaleStillSending =
            r.status === "error" && /still sending/i.test(String(r.error || ""));
          const isFakeDone = r.status === "done" && !r.mediaUrl;
          if (isFakeDone || isStaleStillSending) {
            hadInvalidStatus = true;
          }
          const recoveredStatus =
            (r.status === "running" && !activeClientRowIds.has(r.id)) ||
            isStaleStillSending ||
            isFakeDone
              ? r.mediaUrl
                ? "done"
                : "idle"
              : r.status || "idle";
          const rowMode = r.mode === "image" ? "image" : "video";
          return {
            quality: "4K",
            duration: "20s",
            characterImage: null,
            productImage: null,
            referenceImage: null,
            ...r,
            status: recoveredStatus,
            error: isStaleStillSending ? "" : r.error || "",
            mode: rowMode,
            stepOrder: rowMode === "image" ? 1 : 2,
          };
        });
        if (hadInvalidStatus) {
          saveBatchRows();
        }

        for (const r of state.batchRows) {
          if (!state.bulkCharacterImage && r.characterImage && r.characterImage.dataUrl) {
            state.bulkCharacterImage = { ...r.characterImage };
            if ($("#bulkCharacterThumb")) $("#bulkCharacterThumb").src = r.characterImage.dataUrl;
            if ($("#bulkCharacterName"))
              $("#bulkCharacterName").textContent = r.characterImage.name || "NV";
            if ($("#bulkCharacterPreviewBox"))
              $("#bulkCharacterPreviewBox").style.display = "inline-flex";
            break;
          }
        }

        sortBatchRowsByStream();
        renderProductChips();
      } else {
        state.batchRows = [];
        renderProductChips();
        await saveBatchRows();
      }
      renderBatchTable();
    } catch (_err) {
      renderBatchTable();
    }
  }

  let saveTimer = null;
  function scheduleSaveBatchRows() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveBatchRows();
    }, 450);
  }

  async function saveBatchRows() {
    try {
      const slimRows = state.batchRows.map((r) => ({
        ...r,
        status: r.status === "running" ? "idle" : r.status,
      }));
      await api("/admin/batch-rows", {
        method: "POST",
        body: { rows: slimRows },
      });
    } catch (_err) {
      // ignore
    }
  }

  function updateBatchStats() {
    const total = state.batchRows.length;
    const selected = state.batchRows.filter((r) => r.selected).length;
    const running = state.batchRows.filter((r) => r.status === "running").length;
    const done = state.batchRows.filter((r) => r.status === "done").length;

    if ($("#batchStatTotal")) $("#batchStatTotal").textContent = String(total);
    if ($("#batchStatSelected")) $("#batchStatSelected").textContent = String(selected);
    if ($("#batchStatRunning")) $("#batchStatRunning").textContent = String(running);
    if ($("#batchStatDone")) $("#batchStatDone").textContent = String(done);
    if ($("#navBadgeBatch")) $("#navBadgeBatch").textContent = String(total);
  }

  function rowStatusBadge(row) {
    if (row.status === "running") {
      const { pct, shortText, fullTitle } = buildCompactRunningBadgeParts(row);
      return `
        <div class="compact-status-wrap" data-row-status-id="${row.id}" title="${escapeHtml(fullTitle)}">
          <span class="badge badge-running">${ICON.spinner}<span>${escapeHtml(shortText)}</span></span>
          <div class="mini-progress-track"><div class="mini-progress-fill" style="width:${pct}%"></div></div>
        </div>`;
    }
    if (row.status === "done") return `<span class="badge badge-ok">${ICON.check}<span>Hoàn tất</span></span>`;
    if (row.status === "error") {
      return `<span class="badge badge-fail" title="${escapeHtml(row.error)}">${ICON.alert}<span>Lỗi</span></span>`;
    }
    return `<span class="badge badge-idle">Chờ chạy</span>`;
  }

  // Character, product and first-frame slots of one row; the actions are the row handlers' own.
  function rowRefSlots(row) {
    const slot = (img, upload, clear, preview, icon, label, title) =>
      img && img.dataUrl
        ? `<span class="ref-slot-filled">
             <img src="${img.dataUrl}" alt="${escapeHtml(title)}" class="ref-thumb" data-row-action="${preview}" data-id="${row.id}" />
             <button class="btn btn-danger btn-sm" data-row-action="${clear}" data-id="${row.id}" title="Bỏ ${escapeHtml(title)}">×</button>
           </span>`
        : `<button class="btn btn-soft btn-sm" data-row-action="${upload}" data-id="${row.id}" title="Thêm ${escapeHtml(title)}">${icon}<span>${label}</span></button>`;
    return `<div class="ref-box">
      ${slot(row.characterImage, "upload-character", "clear-character", "preview-character", ICON.userPlus, "NV", "ảnh nhân vật")}
      ${slot(row.productImage, "upload-product", "clear-product", "preview-product", ICON.packagePlus, "SP", "ảnh sản phẩm")}
      ${slot(row.referenceImage, "upload-ref", "clear-ref", "preview-ref", ICON.image, "Khung đầu", "ảnh khung đầu")}
    </div>`;
  }

  function rowSettingsSelects(row) {
    const opts = (values, current, label = (v) => v) =>
      values.map((v) => `<option value="${v}" ${current === v ? "selected" : ""}>${label(v)}</option>`).join("");
    return `
      <div><label class="field-label" for="previewMode">Loại</label>
        <select id="previewMode" class="select row-mode-select" data-id="${row.id}">
          ${opts(["video", "image"], row.mode === "image" ? "image" : "video", (v) => (v === "image" ? "Ảnh" : "Video"))}
        </select></div>
      <div><label class="field-label" for="previewAspect">Tỉ lệ</label>
        <select id="previewAspect" class="select row-aspect-select" data-id="${row.id}">${opts(["9:16", "16:9", "1:1", "4:3", "3:4"], row.aspectRatio)}</select></div>
      <div><label class="field-label" for="previewDuration">Thời lượng</label>
        <select id="previewDuration" class="select row-duration-select" data-id="${row.id}">${opts(DURATION_OPTIONS, row.duration || "20s")}</select></div>
      <div><label class="field-label" for="previewQuality">Độ phân giải</label>
        <select id="previewQuality" class="select row-quality-select" data-id="${row.id}">${opts(QUALITY_OPTIONS, row.quality || "4K")}</select></div>`;
  }

  function rowMeta(row, idx) {
    const parts = [`#${idx + 1}`, row.mode === "image" ? "Ảnh" : "Video", row.aspectRatio || "9:16"];
    if (row.mode !== "image") parts.push(row.duration || "20s");
    parts.push(row.quality || "4K", row.accountName || "tài khoản tự động");
    return parts.join(", ");
  }

  function isVideoRow(row) {
    const url = String(row.mediaUrl || "").toLowerCase();
    return row.mode === "video" || url.endsWith(".mp4") || url.endsWith(".webm");
  }

  // The list shows one line of a prompt (about 40 characters fit the 1440px column); the preview holds the whole text.
  const QUEUE_PROMPT_CHARS = 40;
  function shortPrompt(text) {
    const s = String(text || "").trim();
    return s.length > QUEUE_PROMPT_CHARS ? `${s.slice(0, QUEUE_PROMPT_CHARS - 1).trimEnd()}…` : s;
  }

  function visibleRows() {
    const q = state.queueFilter.q.trim().toLowerCase();
    const status = state.queueFilter.status;
    return state.batchRows.filter(
      (r) => (status === "all" || (r.status || "idle") === status) && (!q || String(r.prompt || "").toLowerCase().includes(q))
    );
  }

  function renderQueuePreview() {
    const box = $("#queuePreview");
    if (!box) return;
    const row = state.batchRows.find((r) => r.id === state.previewRowId) || state.batchRows[0];
    if (!row) {
      box.dataset.rowId = "";
      box.innerHTML = `<div class="preview-media preview-media-empty">Chọn một luồng trong hàng đợi để xem video, prompt và ảnh tham chiếu.</div>`;
      return;
    }
    const idx = state.batchRows.indexOf(row);
    // Never rebuild under the user's cursor: a status tick would wipe what they are typing, so only refresh status/meta if focused.
    if (box.dataset.rowId === row.id && box.contains(document.activeElement) && document.activeElement.matches("textarea, input, select")) {
      const metaEl = box.querySelector(".preview-meta");
      if (metaEl) {
        metaEl.innerHTML = `${rowStatusBadge(row)}<span>${escapeHtml(rowMeta(row, idx))}</span>`;
      }
      return;
    }
    state.previewRowId = row.id;
    box.dataset.rowId = row.id;
    const media = row.mediaUrl
      ? isVideoRow(row)
        ? `<video src="${escapeHtml(row.mediaUrl)}" class="preview-media" controls playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(row.mediaUrl)}" alt="${escapeHtml(row.filename || "Kết quả")}" class="preview-media" />`
      : `<div class="preview-media preview-media-empty">${
          row.status === "running" ? "Đang tạo, kết quả sẽ hiện ở đây." : row.status === "error" ? "Luồng này bị lỗi, xem chi tiết bên dưới." : "Chưa chạy. Bấm Chạy để tạo."
        }</div>`;
    const runOrStopBtns =
      row.status === "running"
        ? `<button class="btn btn-warn btn-sm" data-row-action="stop" data-id="${row.id}" title="Dừng tiến trình tạo video/ảnh của luồng này">${ICON.stop}<span>Dừng luồng này</span></button>
           <button class="btn btn-primary btn-sm" data-row-action="restart" data-id="${row.id}" title="Dừng tiến trình đang chạy và chạy lại ngay với Prompt vừa sửa">${ICON.refresh}<span>Lưu &amp; Chạy lại</span></button>`
        : `<button class="btn btn-primary btn-sm" data-row-action="run" data-id="${row.id}">${ICON.play}<span>Chạy luồng này</span></button>`;
    box.innerHTML = `
      ${media}
      <div class="preview-meta">${rowStatusBadge(row)}<span>${escapeHtml(rowMeta(row, idx))}</span></div>
      ${row.status === "error" && row.error ? `<p class="preview-error">${escapeHtml(row.error)}</p>` : ""}
      <label class="field-label" for="previewPrompt">Prompt (Có thể sửa trực tiếp ngay cả khi đang chạy)</label>
      <textarea id="previewPrompt" class="textarea preview-prompt row-prompt-input" data-id="${row.id}" spellcheck="false" placeholder="Nhập prompt cho luồng này…">${escapeHtml(row.prompt)}</textarea>
      <div class="preview-settings">${rowSettingsSelects(row)}</div>
      <span class="field-label">Ảnh tham chiếu</span>
      ${rowRefSlots(row)}
      <div class="preview-actions">
        ${runOrStopBtns}
        ${row.mediaUrl ? `<button class="btn btn-soft btn-sm" data-row-action="preview-media" data-id="${row.id}">${ICON.search}<span>Xem lớn</span></button>
        <a class="btn btn-sm" href="${escapeHtml(row.mediaUrl)}" download="${escapeHtml(row.filename || "")}">${ICON.download}<span>Tải về</span></a>` : ""}
        <button class="btn btn-danger btn-sm" data-row-action="delete" data-id="${row.id}" title="Xoá luồng này (tự dừng nếu đang chạy)">${ICON.trash}<span>Xoá</span></button>
      </div>`;
  }

  function renderBatchTable() {
    updateBatchStats();
    segSyncers.forEach((sync) => sync());
    const list = $("#batchTableBody");
    if (!list) return;
    const rows = visibleRows();
    const total = state.batchRows.length;
    if (!state.batchRows.some((r) => r.id === state.previewRowId)) {
      state.previewRowId = (rows[0] || state.batchRows[0] || {}).id || "";
    }
    const selectedVisCount = rows.filter((r) => r.selected).length;
    const selectAllEl = $("#selectAllBatch");
    if (selectAllEl) {
      selectAllEl.checked = rows.length > 0 && selectedVisCount === rows.length;
      selectAllEl.indeterminate = selectedVisCount > 0 && selectedVisCount < rows.length;
    }
    if ($("#queueCount")) {
      const baseCount = rows.length === total ? `${total} luồng` : `${rows.length}/${total} luồng`;
      $("#queueCount").textContent =
        selectedVisCount > 0 ? `Đã chọn ${selectedVisCount}/${baseCount}` : baseCount;
    }

    if (!total) {
      list.innerHTML = `
        <div class="shadcn-empty-state">
          <div class="shadcn-empty-icon">${ICON.clapperboard}</div>
          <div class="shadcn-empty-title">Hàng đợi đang trống</div>
          <div class="shadcn-empty-desc">Viết prompt ở cột bên trái rồi bấm "Chỉ thêm vào hàng đợi", hoặc kéo thả ảnh sản phẩm vào màn hình này.</div>
          <div class="shadcn-empty-actions">
            <button type="button" class="btn btn-primary" data-empty-create-from-prompt="1">${ICON.plus}<span>Thêm từ prompt</span></button>
            <button type="button" class="btn btn-soft" data-empty-upload-products="1">${ICON.upload}<span>Chọn ảnh sản phẩm</span></button>
          </div>
        </div>`;
      renderQueuePreview();
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="queue-empty">Không có luồng nào khớp bộ lọc.</div>`;
      renderQueuePreview();
      return;
    }

    const view = state.queueView;
    list.className = `queue-list is-${view}`;
    list.setAttribute("role", view === "table" ? "presentation" : "list");
    const thumbOf = (row) => {
      const thumbSrc = row.mediaUrl || row.productImage?.dataUrl || "";
      return row.mediaUrl && isVideoRow(row)
        ? `<video src="${escapeHtml(`${row.mediaUrl}${row.mediaUrl.includes("?") ? "&" : "?"}r=2#t=0.5`)}" preload="metadata" muted playsinline aria-hidden="true"></video>`
        : thumbSrc
        ? `<img src="${escapeHtml(thumbSrc)}" alt="" />`
        : row.mode === "image" ? ICON.image : ICON.clapperboard;
    };
    const check = (row, idx) =>
      `<input type="checkbox" class="row-check" data-id="${row.id}" ${row.selected ? "checked" : ""} aria-label="Chọn luồng ${idx + 1}" />`;
    const active = (row) => (row.id === state.previewRowId ? " is-active" : "");
    const rowQuickActions = (row) => `
      <div class="queue-row-actions">
        ${
          row.status === "running"
            ? `<button type="button" class="btn btn-warn btn-sm" data-row-action="stop" data-id="${row.id}" title="Dừng luồng đang chạy">${ICON.stop}<span>Dừng</span></button>`
            : `<button type="button" class="btn btn-soft btn-sm" data-row-action="run" data-id="${row.id}" title="Chạy luồng này">${ICON.play}</button>`
        }
        <button type="button" class="btn btn-sm" data-row-action="edit" data-id="${row.id}" title="Sửa prompt luồng này">${ICON.edit}</button>
        <button type="button" class="btn btn-danger btn-sm" data-row-action="delete" data-id="${row.id}" title="Xoá luồng này">${ICON.trash}</button>
      </div>`;

    if (view === "table") {
      list.innerHTML = `
        <table class="data-table queue-table">
          <thead><tr>
            <th scope="col"><span class="sr-only">Chọn</span></th><th scope="col">#</th><th scope="col">Prompt</th>
            <th scope="col">Loại</th><th scope="col">Tỉ lệ</th><th scope="col">Thời lượng</th><th scope="col">Độ phân giải</th>
            <th scope="col">Tài khoản</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th>
          </tr></thead>
          <tbody>${rows
            .map((row) => {
              const idx = state.batchRows.indexOf(row);
              return `<tr class="${active(row).trim()}" data-row-id="${row.id}">
                <td>${check(row, idx)}</td>
                <td>${idx + 1}</td>
                <td><button type="button" class="queue-open" data-preview-id="${row.id}" title="${escapeHtml(row.prompt || "")}"><span class="queue-prompt">${escapeHtml(shortPrompt(row.prompt) || "Chưa có prompt")}</span></button></td>
                <td>${row.mode === "image" ? "Ảnh" : "Video"}</td>
                <td>${escapeHtml(row.aspectRatio || "9:16")}</td>
                <td>${row.mode === "image" ? "" : escapeHtml(row.duration || "20s")}</td>
                <td>${escapeHtml(row.quality || "4K")}</td>
                <td>${escapeHtml(row.accountName || "Tự động")}</td>
                <td>${rowStatusBadge(row)}</td>
                <td>${rowQuickActions(row)}</td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>`;
      renderQueuePreview();
      return;
    }

    if (view === "grid") {
      list.innerHTML = rows
        .map((row) => {
          const idx = state.batchRows.indexOf(row);
          return `
            <div class="queue-card${active(row)}" role="listitem" data-row-id="${row.id}">
              ${check(row, idx)}
              <button type="button" class="queue-card-open" data-preview-id="${row.id}" title="${escapeHtml(row.prompt || "")}">
                <span class="queue-card-thumb">${thumbOf(row)}</span>
                <span class="queue-prompt">${escapeHtml(shortPrompt(row.prompt) || "Chưa có prompt")}</span>
                <span class="queue-meta">${escapeHtml(rowMeta(row, idx))}</span>
              </button>
              <div class="queue-card-status">${rowStatusBadge(row)}${rowQuickActions(row)}</div>
            </div>`;
        })
        .join("");
      renderQueuePreview();
      return;
    }

    list.innerHTML = rows
      .map((row) => {
        const idx = state.batchRows.indexOf(row);
        const thumb = thumbOf(row);
        return `
          <div class="queue-item${row.id === state.previewRowId ? " is-active" : ""}" role="listitem" data-row-id="${row.id}">
            <input type="checkbox" class="row-check" data-id="${row.id}" ${row.selected ? "checked" : ""} aria-label="Chọn luồng ${idx + 1}" />
            <div class="queue-thumb">${thumb}</div>
            <button type="button" class="queue-open" data-preview-id="${row.id}" title="${escapeHtml(row.prompt || "")}">
              <span class="queue-prompt">${escapeHtml(shortPrompt(row.prompt) || "Chưa có prompt")}</span>
              <span class="queue-meta">${escapeHtml(rowMeta(row, idx))}</span>
            </button>
            <div class="queue-row-right">
              <div class="queue-status">${rowStatusBadge(row)}</div>
              ${rowQuickActions(row)}
            </div>
          </div>`;
      })
      .join("");
    renderQueuePreview();
  }

  // Chip groups drive the original selects, so every reader and change handler of those selects keeps working.
  const segSyncers = [];
  function bindSegToSelect(name, selectId) {
    const select = $(`#${selectId}`);
    const radios = Array.from(document.querySelectorAll(`input[name="${name}"]`));
    if (!select || !radios.length) return;
    const sync = () => radios.forEach((r) => (r.checked = r.value === select.value));
    radios.forEach((r) =>
      r.addEventListener("change", () => {
        if (!r.checked) return;
        select.value = r.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })
    );
    select.addEventListener("change", sync);
    segSyncers.push(sync);
    sync();
  }

  let activeBatchQueue = [];
  let batchGeneration = 0;
  let lastClickedCheckRowId = "";

  async function stopRows(targetRows, { silent = false, cancelAllServer = false } = {}) {
    const rows = Array.isArray(targetRows) ? targetRows.filter(Boolean) : [];
    const rowIds = [];
    const jobIds = [];

    for (const r of rows) {
      rowIds.push(r.id);
      if (r.jobId) jobIds.push(r.jobId);
      r.cancelledByUser = true;
      r.runToken = null;
      r.status = r.mediaUrl ? "done" : "idle";
      r.error = "";
      r.progressPct = 0;
      r.progressText = "Đã dừng";
      activeClientRowIds.delete(r.id);
      delete r.jobId;
    }

    if (activeBatchQueue.length > 0 && rowIds.length > 0) {
      const stopSet = new Set(rowIds);
      activeBatchQueue = activeBatchQueue.filter((item) => !stopSet.has(item.id));
    }

    if (cancelAllServer) {
      batchGeneration += 1;
      activeBatchQueue = [];
      activeClientRowIds.clear();
      state.batchRunning = false;
    } else if (activeClientRowIds.size === 0 && activeBatchQueue.length === 0) {
      state.batchRunning = false;
    }

    saveBatchRows();
    renderBatchTable();

    if (rowIds.length > 0 || jobIds.length > 0 || cancelAllServer) {
      await api("/admin/generate/cancel", {
        method: "POST",
        body: {
          rowIds,
          jobIds,
          all: Boolean(cancelAllServer),
        },
      }).catch(() => {});
      loadStatus();
    }

    if (!silent && rows.length > 0) {
      showToast(`Đã dừng ${rows.length} luồng đang chạy!`);
    }
    return rows.length;
  }

  async function stopSelectedBatch() {
    const selectedRunning = state.batchRows.filter(
      (r) => r.selected && (r.status === "running" || activeClientRowIds.has(r.id))
    );
    if (selectedRunning.length > 0) {
      await stopRows(selectedRunning);
      return;
    }
    if (state.batchRows.some((r) => r.selected)) {
      showToast("Các luồng đã chọn không có luồng nào đang chạy.", true);
      return;
    }
    const allRunning = state.batchRows.filter(
      (r) => r.status === "running" || activeClientRowIds.has(r.id)
    );
    if (allRunning.length > 0) {
      await stopRows(allRunning, { cancelAllServer: true });
      return;
    }
    showToast("Hiện không có luồng nào đang chạy để dừng.", true);
  }

  async function stopAllBatch() {
    const allRunning = state.batchRows.filter(
      (r) => r.status === "running" || activeClientRowIds.has(r.id)
    );
    await stopRows(allRunning, { silent: true, cancelAllServer: true });
    showToast(
      allRunning.length > 0
        ? `Đã dừng toàn bộ ${allRunning.length} luồng đang chạy!`
        : "Đã dừng mọi tiến trình đang chạy trên máy chủ!"
    );
  }

  async function bulkApplyPromptToSelected() {
    const selected = state.batchRows.filter((r) => r.selected);
    if (!selected.length) {
      showToast("Vui lòng tích chọn ít nhất 1 luồng để sửa hàng loạt!", true);
      return;
    }
    const runningSelected = selected.filter(
      (r) => r.status === "running" || activeClientRowIds.has(r.id)
    );
    if (runningSelected.length > 0) {
      await stopRows(runningSelected, { silent: true });
    }

    const fixedVidPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
    const bulkMode = $("#bulkModeSelect")?.value || "video";
    const aspectRatio = $("#bulkAspectSelect")?.value || "9:16";
    const duration = $("#bulkDurationSelect")?.value || "20s";
    const quality = $("#bulkQualitySelect")?.value || "4K";
    const accountId = $("#bulkAccountSelect")?.value || "";
    const accObj = state.accounts.find((a) => a.id === accountId);
    const accountName = accObj ? accObj.name : "";
    const charImg = state.bulkCharacterImage;

    const linePrompts =
      state.promptMode === "lines"
        ? window.MusePromptLines.splitPromptLines($("#bulkVideoPromptsInput")?.value)
        : [];

    // Finished rows keep the prompt and settings their video was made with.
    const editable = selected.filter((r) => r.status !== "done");
    const skippedDone = selected.length - editable.length;
    if (!editable.length) {
      showToast("Các luồng đã chọn đều đã hoàn tất, không sửa luồng nào.", true);
      return;
    }
    editable.forEach((r, idx) => {
      if (state.promptMode === "lines" && linePrompts.length > 0) {
        r.prompt = linePrompts[idx % linePrompts.length];
      } else if (fixedVidPrompt.trim()) {
        r.prompt = fixedVidPrompt.trim();
      }
      r.mode = bulkMode;
      r.stepOrder = bulkMode === "image" ? 1 : 2;
      r.aspectRatio = aspectRatio;
      r.duration = duration;
      r.quality = quality;
      if (accountId !== undefined) {
        r.accountId = accountId;
        if (accountName) r.accountName = accountName;
      }
      if (charImg) {
        r.characterImage = { ...charImg };
      }
      if (r.status === "error") {
        r.status = "idle";
        r.error = "";
      }
    });

    saveBatchRows();
    renderBatchTable();
    showToast(
      `Đã cập nhật Prompt & Cấu hình cho ${editable.length} luồng đã chọn${
        runningSelected.length > 0 ? ` (đã dừng ${runningSelected.length} luồng đang chạy)` : ""
      }${skippedDone > 0 ? `, bỏ qua ${skippedDone} luồng đã hoàn tất` : ""}!`
    );
  }

  // Quick picks act on what the filter shows; hidden rows are unselected so a bulk action never reaches them.
  function selectVisible(pred) {
    const shown = new Set(visibleRows());
    state.batchRows.forEach((r) => (r.selected = shown.has(r) && pred(r)));
    renderBatchTable();
  }

  function retryErroredRows() {
    const errored = state.batchRows.filter((r) => r.status === "error");
    if (!errored.length) {
      showToast("Không có luồng nào bị lỗi.", true);
      return;
    }
    state.batchRows.forEach((r) => (r.selected = r.status === "error"));
    errored.forEach((r) => {
      r.status = "idle";
      r.error = "";
    });
    renderBatchTable();
    return runSelectedBatch();
  }

  async function runSingleRow(row, options = {}) {
    if (!row || !row.prompt.trim()) {
      showToast("Prompt không được để trống!", true);
      return;
    }
    if (activeClientRowIds.has(row.id) || row.status === "running") {
      return;
    }
    row.cancelledByUser = false;
    // A newer run or a stop replaces the token; this run then stops touching the row.
    const runToken = {};
    row.runToken = runToken;
    const isStale = () => row.runToken !== runToken;
    activeClientRowIds.add(row.id);
    const rowMode = row.mode === "image" ? "image" : "video";
    row.mode = rowMode;
    row.status = "running";
    row.error = "";
    row.mediaUrl = "";
    row.filename = "";
    row.progressPct = 5;
    row.progressText = "Đang khởi tạo trên cổng Gateway...";
    renderBatchTable();

    try {
      const refImgs = [];
      let charImgPayload = null;
      let prodImgPayload = null;
      if (row.characterImage && row.characterImage.b64) {
        charImgPayload = {
          b64: row.characterImage.b64,
          mime: row.characterImage.mime || "image/png",
          name: row.characterImage.name || "character.png",
          role: "character",
        };
      }
      if (row.productImage && row.productImage.b64) {
        prodImgPayload = {
          b64: row.productImage.b64,
          mime: row.productImage.mime || "image/png",
          name: row.productImage.name || "product.png",
          role: "product",
        };
      }
      if (row.referenceImage && row.referenceImage.b64) {
        refImgs.push({
          b64: row.referenceImage.b64,
          mime: row.referenceImage.mime || "image/png",
          name: row.referenceImage.name || "ref.png",
          role: "reference",
        });
      }

      const startRes = await api("/admin/generate", {
        method: "POST",
        body: {
          async: true,
          rowId: row.id,
          mode: rowMode,
          prompt: row.prompt,
          aspectRatio: row.aspectRatio || "9:16",
          duration: row.duration || "20s",
          quality: row.quality || "4K",
          characterImage: charImgPayload,
          productImage: prodImgPayload,
          referenceImages: refImgs,
          linkedImageFilename: row.referenceImage?.linkedFilename || row.linkedImageFilename || "",
          accountId: row.accountId || "",
        },
      });

      if (isStale()) {
        if (startRes?.jobId) {
          api("/admin/generate/cancel", { method: "POST", body: { jobIds: [startRes.jobId] } }).catch(() => {});
        }
        return;
      }

      let res = null;
      if (startRes.async && startRes.jobId) {
        row.jobId = startRes.jobId;
        const pollStartedAt = Date.now();
        const maxPollMs = 120 * 60 * 1000; // Wait up to 120 minutes for multi-stream / long video stitching
        while (Date.now() - pollStartedAt < maxPollMs) {
          if (isStale()) return;
          await new Promise((r) => setTimeout(r, 1500));
          if (isStale()) return;
          let jobRes = null;
          try {
            jobRes = await api(`/admin/generate/job/${encodeURIComponent(startRes.jobId)}`);
          } catch (pollErr) {
            if (isStale()) return;
            if (/Job not found|404/i.test(String(pollErr.message || ""))) {
              throw new Error("Tiến trình tạo video trên máy chủ đã bị ngắt hoặc hết hạn");
            }
            continue;
          }
          if (isStale() || jobRes.status === "cancelled") {
            return;
          }
          if (typeof jobRes.progress === "number" && jobRes.progress > 0) {
            row.progressPct = jobRes.progress;
          }
          if (jobRes.progress_text) {
            row.progressText = jobRes.progress_text;
          }
          updateRunningRowBadgesInDom();
          if (jobRes.status === "done" && jobRes.result) {
            res = jobRes.result;
            break;
          }
          if (jobRes.status === "error") {
            throw new Error(jobRes.error || "Lỗi tạo video qua cổng Gateway");
          }
        }
        if (isStale()) return;
        if (!res) {
          throw new Error("Quá thời gian chờ tạo & ghép video hoàn tất");
        }
      } else {
        res = startRes;
      }

      if (isStale()) return;
      if (!res || !res.mediaUrl) {
        throw new Error("Chrome chưa xuất xong file Video hoàn chỉnh");
      }

      row.status = "done";
      row.progressPct = 100;
      row.progressText = "Hoàn tất 100%";
      row.mediaUrl = res.mediaUrl || "";
      row.filename = res.filename || "";
      if (res.productTitle) {
        row.productTitle = res.productTitle;
      }
      row.accountName = res.accountName || row.accountName || "Muse OK";
      saveBatchRows();
      renderBatchTable();
      loadStatus();
    } catch (err) {
      if (isStale()) return;
      if (/Đã dừng bởi người dùng|cancelled/i.test(String(err?.message || ""))) {
        row.status = row.mediaUrl ? "done" : "idle";
        row.error = "";
        row.progressPct = 0;
        row.progressText = "Đã dừng";
        saveBatchRows();
        renderBatchTable();
        return;
      }
      row.status = "error";
      row.error = err.message;
      saveBatchRows();
      renderBatchTable();
      showToast(`Lỗi dòng [${row.prompt.slice(0, 28)}...]: ${err.message}`, true);
    } finally {
      if (!isStale()) {
        activeClientRowIds.delete(row.id);
        delete row.jobId;
        row.runToken = null;
      }
      if (!options.fromBatch && activeClientRowIds.size === 0 && !state.batchRunning) {
        await api("/admin/chrome/close", { method: "POST" }).catch(() => {});
        loadStatus();
      }
    }
  }

  async function runSelectedBatch() {
    if (state.batchRunning && activeBatchQueue.length > 0) {
      showToast("Đang có tiến trình chạy hàng loạt đang thực thi!", true);
      return;
    }
    sortBatchRowsByStream();
    renderProductChips();

    // Recover any stale "running" status or empty "done" status on rows that aren't actively managed by this client
    for (const r of state.batchRows) {
      if (
        (r.status === "running" && !activeClientRowIds.has(r.id)) ||
        (r.status === "done" && !r.mediaUrl)
      ) {
        r.status = r.mediaUrl ? "done" : "idle";
      }
    }

    const runnableRows = state.batchRows.filter(
      (r) => !activeClientRowIds.has(r.id) && r.status !== "running" && r.prompt && r.prompt.trim()
    );

    // 1. Check explicitly selected rows
    const selectedRows = runnableRows.filter((r) => r.selected);
    const selectedPending = selectedRows.filter((r) => r.status !== "done");

    let targets = [];
    if (selectedPending.length > 0) {
      targets = selectedPending;
    } else if (selectedRows.length > 0) {
      // Only "done" rows were selected -> user wants to re-run them
      targets = selectedRows;
    } else {
      // Nothing was checked -> auto-select all pending (non-done) rows and run them!
      const allPending = runnableRows.filter((r) => r.status !== "done");
      if (allPending.length > 0) {
        allPending.forEach((r) => {
          r.selected = true;
        });
        targets = allPending;
      }
    }

    saveBatchRows();
    renderBatchTable();

    if (!targets.length) {
      if (activeClientRowIds.size > 0) {
        showToast(`Đang có ${activeClientRowIds.size} luồng đang chạy!`, true);
      } else {
        showToast("Vui lòng tích chọn ít nhất 1 luồng (hoặc thêm sản phẩm mới) để chạy!", true);
      }
      return;
    }

    state.batchRunning = true;
    const configuredConcurrency = Math.max(1, Number($("#bulkConcurrencySelect")?.value || 2));
    // The dropdown is a cap: extra rows wait in the queue instead of opening more Chrome tabs.
    const streamConcurrency = Math.min(configuredConcurrency, targets.length);

    showToast(
      `Bắt đầu chạy ${targets.length} Luồng (tối đa ${streamConcurrency} luồng song song)...`
    );

    const batchId = ++batchGeneration;
    activeBatchQueue = [...targets];
    const workers = Array.from(
      { length: Math.min(streamConcurrency, activeBatchQueue.length) },
      async () => {
        while (activeBatchQueue.length > 0 && state.batchRunning && batchId === batchGeneration) {
          const item = activeBatchQueue.shift();
          if (item && state.batchRows.includes(item)) {
            await runSingleRow(item, { fromBatch: true });
          }
        }
      }
    );
    await Promise.all(workers);
    if (batchId !== batchGeneration) return;

    if (activeClientRowIds.size === 0) {
      const wasRunning = state.batchRunning;
      state.batchRunning = false;
      activeBatchQueue = [];
      await api("/admin/chrome/close", { method: "POST" }).catch(() => {});
      loadStatus();
      if (wasRunning) {
        const doneCount = targets.filter((r) => r.status === "done" && r.mediaUrl).length;
        const errCount = targets.filter((r) => r.status === "error").length;
        if (errCount === 0 && doneCount > 0) {
          showToast(
            `Đã hoàn tất ${doneCount}/${targets.length} Luồng sản xuất Video!`
          );
        } else if (errCount > 0) {
          showToast(
            `Đã xử lý xong: Hoàn tất ${doneCount}/${targets.length} luồng, lỗi ${errCount} luồng.`,
            errCount === targets.length
          );
        }
      }
    }
  }

  async function downloadSelectedBatch() {
    const readyRows = state.batchRows.filter((r) => r.selected && r.mediaUrl && r.filename);
    if (!readyRows.length) {
      showToast("Chưa có dòng nào được chọn có sẵn file Video/Ảnh hoàn tất!", true);
      return;
    }

    if (window.embongDesktop && window.embongDesktop.chooseDownloadFolder) {
      const folderRes = await window.embongDesktop.chooseDownloadFolder();
      if (folderRes.canceled || !folderRes.folderPath) return;
      const filenames = readyRows.map((r) => r.filename);
      const out = await window.embongDesktop.exportMediaFiles({
        filenames,
        targetDir: folderRes.folderPath,
      });
      if (out.ok) {
        showToast(`Đã xuất ${out.copied} file vào thư mục: ${folderRes.folderPath}`);
      }
      return;
    }

    for (const r of readyRows) {
      const a = document.createElement("a");
      a.href = r.mediaUrl;
      a.download = r.filename || "muse_media";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    showToast(`Đang tải xuống ${readyRows.length} file...`);
  }

  // ==================== MEDIA GALLERY ====================
  async function loadMedia() {
    try {
      const data = await api("/admin/media");
      state.media = data.media || [];
      renderMediaGallery();
    } catch (_err) {
      // ignore
    }
  }

  function renderMediaGallery() {
    const grid = $("#mediaGalleryGrid");
    if (!grid) return;
    const filter = $("#mediaFilterSelect")?.value || "all";
    const items = state.media.filter((m) => filter === "all" || m.type === filter);

    if ($("#mediaStatTotal")) $("#mediaStatTotal").textContent = String(items.length);

    if (!items.length) {
      grid.innerHTML = `<div class="card" style="grid-column: 1 / -1; text-align:center; padding: 36px; color: var(--muted-foreground)">Chưa có Video hoặc Ảnh nào trong thư viện.</div>`;
      return;
    }

    grid.innerHTML = items
      .map((item) => {
        const kb = Math.round((item.size || 0) / 1024);
        const vidThumbSrc =
          item.type === "video"
            ? `${item.url}${item.url.includes("?") ? "&" : "?"}s=${item.size || 0}#t=0.5`
            : item.url;
        return `
          <div class="media-item">
            ${
              item.type === "video"
                ? `<video src="${escapeHtml(vidThumbSrc)}" class="media-preview" preload="metadata" playsinline muted loop onmouseover="this.play()" onmouseout="this.pause()" data-media-preview="${escapeHtml(item.url)}" data-media-type="video" data-media-name="${escapeHtml(item.name)}"></video>`
                : `<img src="${escapeHtml(item.url)}" class="media-preview" data-media-preview="${escapeHtml(item.url)}" data-media-type="image" data-media-name="${escapeHtml(item.name)}" />`
            }
            <div class="media-meta">
              <div class="media-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
              <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--muted-foreground)">
                <span>${item.type === "video" ? "Video" : "Ảnh"} · ${kb} KB</span>
                <span>${formatTimeAgo(item.created_at)}</span>
              </div>
              <div style="display:flex; gap:6px; margin-top:4px">
                <button class="btn btn-soft btn-sm" style="flex:1" data-media-preview="${escapeHtml(item.url)}" data-media-type="${item.type}" data-media-name="${escapeHtml(item.name)}">${ICON.search}<span>Xem</span></button>
                <a class="btn btn-sm" href="${escapeHtml(item.url)}" download="${escapeHtml(item.name)}">${ICON.download}</a>
                <button class="btn btn-danger btn-sm" data-media-delete="${escapeHtml(item.name)}">${ICON.trash}</button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ==================== TASKS & LOGS ====================
  async function loadTasksAndLogs() {
    try {
      const [tData, lData] = await Promise.all([api("/admin/tasks"), api("/admin/logs")]);
      state.tasks = tData.tasks || [];
      state.logs = lData.logs || [];

      const tbody = $("#tasksTableBody");
      if (tbody) {
        if (!state.tasks.length) {
          tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted-foreground)">Chưa có tiến trình nào.</td></tr>`;
        } else {
          tbody.innerHTML = state.tasks
            .map((t) => {
              let badge = `<span class="badge badge-running">Đang chạy</span>`;
              if (t.status === "succeeded") badge = `<span class="badge badge-ok">Thành công</span>`;
              if (t.status === "failed")
                badge = `<span class="badge badge-fail" title="${escapeHtml(t.error)}">Lỗi</span>`;
              const sec = t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}s` : "—";
              return `
                <tr>
                  <td><code>${escapeHtml(t.id)}</code></td>
                  <td><strong>${escapeHtml(t.type)}</strong> · ${escapeHtml(t.model)}</td>
                  <td title="${escapeHtml(t.prompt)}">${escapeHtml(String(t.prompt || "").slice(0, 70))}</td>
                  <td>${badge}</td>
                  <td>${sec}</td>
                </tr>`;
            })
            .join("");
        }
      }

      const logBox = $("#engineLogsBox");
      if (logBox) {
        logBox.textContent = state.logs.length
          ? state.logs.map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`).join("\n")
          : "Chưa có nhật ký hoạt động.";
      }
    } catch (_err) {
      // ignore
    }
  }

  // ==================== MODAL PREVIEW ====================
  function openMediaPreview(url, type, title) {
    const modal = $("#mediaPreviewModal");
    const body = $("#modalMediaBody");
    const titleEl = $("#modalMediaTitle");
    const dlBtn = $("#modalDownloadBtn");
    if (!modal || !body) return;

    titleEl.textContent = title || "Xem trước Media";
    dlBtn.href = url;
    dlBtn.download = title || "muse_media";

    if (type === "video" || url.endsWith(".mp4") || url.endsWith(".webm")) {
      const freshUrl = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
      body.innerHTML = `<video src="${escapeHtml(freshUrl)}" controls autoplay playsinline style="max-width:100%; max-height:72vh; border-radius:10px; background:#000"></video>`;
    } else {
      body.innerHTML = `<img src="${escapeHtml(url)}" style="max-width:100%; max-height:72vh; border-radius:10px" />`;
    }
    modal.classList.remove("hidden");
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    $all(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("#themeToggleBtn")?.addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
    });

    $("#zoomOutBtn")?.addEventListener("click", () => applyZoom(state.zoom - 5));
    $("#zoomInBtn")?.addEventListener("click", () => applyZoom(state.zoom + 5));
    $("#zoomValueText")?.addEventListener("click", () => {
      applyZoom(100);
      showToast("Đã đặt lại tỉ lệ thu phóng 100%");
    });

    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          applyZoom(state.zoom + 5);
        } else if (e.key === "-") {
          e.preventDefault();
          applyZoom(state.zoom - 5);
        } else if (e.key === "0") {
          e.preventDefault();
          applyZoom(100);
        }
      }
    });

    window.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          applyZoom(state.zoom + (e.deltaY < 0 ? 5 : -5));
        }
      },
      { passive: false }
    );

    $("#copyEndpointBox")?.addEventListener("click", () => {
      const txt = $("#sideBaseUrlText")?.textContent || "";
      navigator.clipboard.writeText(txt);
      showToast(`Đã sao chép Base URL: ${txt}`);
    });

    $("#btnToggleBulkDrawer")?.addEventListener("click", () => {
      $("#bulkSetupDrawer")?.classList.toggle("hidden");
    });

    $("#btnQuickAiPrompts")?.addEventListener("click", () => {
      switchView("chat");
      $("#scriptTopicInput")?.focus();
    });

    // Fixed Video Prompt: Auto-save to localStorage & live-sync to Product Video Streams
    $("#bulkVideoPromptsInput")?.addEventListener("input", (e) => {
      const val = String(e.target.value || "");
      if (state.promptMode === "lines") {
        // A list only becomes rows on "Thêm vào bảng"; typing never rewrites rows already in the table.
        localStorage.setItem(PROMPT_LINES_KEY, val);
        updatePromptHint();
        return;
      }
      localStorage.setItem(PROMPT_SINGLE_KEY, val);
      const cleanVal = val.trim();
      if (!cleanVal) return;
      for (const r of state.batchRows) {
        if (r.status !== "running" && r.status !== "done") {
          r.prompt = cleanVal;
          const cellEl = document.querySelector(`.row-prompt-input[data-id="${r.id}"]`);
          if (cellEl && document.activeElement !== cellEl) {
            cellEl.value = cleanVal;
          }
        }
      }
      scheduleSaveBatchRows();
    });

    $("#btnResetDefaultPrompts")?.addEventListener("click", () => {
      loadPromptsIntoInput([DEFAULT_FIXED_VIDEO_PROMPT]);
      if (state.promptMode !== "lines") syncStreamsFromProducts({ preserveFinished: false });
      showToast("Đã khôi phục prompt mẫu mặc định.");
    });

    for (const radio of document.querySelectorAll('input[name="promptMode"]')) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        state.promptMode = radio.value === "lines" ? "lines" : "single";
        localStorage.setItem(PROMPT_MODE_KEY, state.promptMode);
        applyPromptMode();
      });
    }
    $("#promptRepeatInput")?.addEventListener("input", updatePromptHint);

    // One shared prompt fills the stream count; a list adds one row per line.
    $("#btnCreateStreamsFromPrompt")?.addEventListener("click", () => {
      if (state.promptMode === "lines") addRowsFromPromptLines();
      else createStreamsFromPrompt();
    });

    $("#btnAddOneStream")?.addEventListener("click", () => {
      addOneStreamFromPrompt();
    });

    // Auto-sync Product Streams when Mode, Aspect Ratio, Duration, Quality, or Account changes
    const onBulkConfigChange = () => {
      if (state.batchRows.length > 0) {
        syncStreamsFromProducts({ preserveFinished: true });
      }
    };
    $("#bulkModeSelect")?.addEventListener("change", onBulkConfigChange);
    $("#bulkAspectSelect")?.addEventListener("change", onBulkConfigChange);
    $("#bulkDurationSelect")?.addEventListener("change", onBulkConfigChange);
    $("#bulkQualitySelect")?.addEventListener("change", onBulkConfigChange);
    $("#bulkAccountSelect")?.addEventListener("change", onBulkConfigChange);

    const triggerBulkProductUpload = () => {
      state.pendingProductTarget = "bulk";
      const input = $("#hiddenProductImageInput");
      if (input) {
        input.multiple = true;
        input.click();
      }
    };

    $("#btnUploadBulkProduct")?.addEventListener("click", triggerBulkProductUpload);
    $("#btnUploadBulkProductTop")?.addEventListener("click", triggerBulkProductUpload);
    $("#btnPromptUploadProducts")?.addEventListener("click", triggerBulkProductUpload);

    $("#btnLoadAndRunBulk")?.addEventListener("click", async () => {
      if (state.batchRows.length === 0) {
        if (state.promptMode === "lines") addRowsFromPromptLines();
        else createStreamsFromPrompt();
      } else {
        syncStreamsFromProducts({ preserveFinished: true });
      }
      await runSelectedBatch();
    });

    // Bulk & Script Character Image Uploaders
    $("#btnUploadBulkCharacter")?.addEventListener("click", () => {
      state.pendingCharacterTarget = "bulk";
      $("#hiddenCharacterImageInput")?.click();
    });
    $("#btnClearBulkCharacter")?.addEventListener("click", () => {
      state.bulkCharacterImage = null;
      if ($("#bulkCharacterPreviewBox")) $("#bulkCharacterPreviewBox").style.display = "none";
      for (const r of state.batchRows) {
        if (r.status !== "running") r.characterImage = null;
      }
      saveBatchRows();
      renderBatchTable();
      showToast("Đã bỏ ảnh nhân vật cố định.");
    });

    $("#btnUploadScriptCharacter")?.addEventListener("click", () => {
      state.pendingCharacterTarget = "script";
      $("#hiddenCharacterImageInput")?.click();
    });
    $("#btnClearScriptCharacter")?.addEventListener("click", () => {
      state.scriptCharacterImage = null;
      if ($("#scriptCharacterPreviewBox")) $("#scriptCharacterPreviewBox").style.display = "none";
      showToast("Đã bỏ ảnh nhân vật trong mục tạo kịch bản.");
    });

    $("#hiddenCharacterImageInput")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !state.pendingCharacterTarget) return;
      const target = state.pendingCharacterTarget;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const comma = dataUrl.indexOf(",");
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        const imgObj = {
          name: file.name,
          mime: file.type || "image/png",
          dataUrl,
          b64,
          role: "character",
        };

        if (target === "bulk") {
          state.bulkCharacterImage = imgObj;
          if ($("#bulkCharacterThumb")) $("#bulkCharacterThumb").src = dataUrl;
          if ($("#bulkCharacterName")) $("#bulkCharacterName").textContent = file.name;
          if ($("#bulkCharacterPreviewBox"))
            $("#bulkCharacterPreviewBox").style.display = "inline-flex";
          for (const r of state.batchRows) {
            if (r.status !== "running" && r.status !== "done") {
              r.characterImage = { ...imgObj };
            }
          }
          saveBatchRows();
          renderBatchTable();
          showToast(`Đã gắn ảnh Nhân vật cố định [${file.name}] cho mọi Luồng Video!`);
        } else if (target === "script") {
          state.scriptCharacterImage = imgObj;
          if ($("#scriptCharacterThumb")) $("#scriptCharacterThumb").src = dataUrl;
          if ($("#scriptCharacterName")) $("#scriptCharacterName").textContent = file.name;
          if ($("#scriptCharacterPreviewBox"))
            $("#scriptCharacterPreviewBox").style.display = "inline-flex";
          showToast(
            `Đã đính kèm ảnh Nhân vật [${file.name}] cho AI viết kịch bản & gắn vào bảng!`
          );
        } else {
          const row = state.batchRows.find((r) => r.id === target);
          if (row) {
            row.characterImage = imgObj;
            saveBatchRows();
            renderBatchTable();
            showToast(`Đã gắn ảnh Nhân vật [${file.name}] vào dòng!`);
          }
        }
      };
      reader.readAsDataURL(file);
    });

    const readFilesAsProductObjs = (files) =>
      Promise.all(
        files
          .filter((f) => f && (!f.type || f.type.startsWith("image/")))
          .map(
            (file) =>
              new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = String(reader.result || "");
                  const comma = dataUrl.indexOf(",");
                  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
                  resolve({
                    id: "prod_" + Math.random().toString(36).slice(2, 9),
                    name: file.name,
                    mime: file.type || "image/png",
                    dataUrl,
                    b64,
                    role: "product",
                  });
                };
                reader.readAsDataURL(file);
              })
          )
      );

    const addBulkProductsAndCreateStreams = async (files) => {
      const loadedObjs = await readFilesAsProductObjs(files);
      if (!loadedObjs.length) return;

      const fixedPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
      const bulkMode = $("#bulkModeSelect")?.value || "video";
      const aspectRatio = $("#bulkAspectSelect")?.value || "9:16";
      const duration = $("#bulkDurationSelect")?.value || "20s";
      const quality = $("#bulkQualitySelect")?.value || "4K";
      const accountId = $("#bulkAccountSelect")?.value || "";
      const accObj = state.accounts.find((a) => a.id === accountId);
      const accountName = accObj ? accObj.name : "Tự động LRU";

      // Uncheck already-completed rows so newly added product streams are the active target
      for (const r of state.batchRows) {
        if (r.status === "done") {
          r.selected = false;
        }
      }

      // Append a new stream row for each uploaded product image (never overwrite/delete existing rows)
      for (const prodImg of loadedObjs) {
        const nextIdx = state.batchRows.length + 1;
        const streamId = prodImg.id || `stream_sp_${Date.now()}_${nextIdx}`;
        const shortName = (prodImg.name || `SP ${nextIdx}`).replace(/\.[^.]+$/, "").slice(0, 18);
        state.batchRows.push({
          id: uid(),
          selected: true,
          streamId,
          streamIndex: nextIdx,
          streamLabel: `SP #${nextIdx} (${shortName})`,
          stepOrder: bulkMode === "image" ? 1 : 2,
          mode: bulkMode,
          prompt: fixedPrompt,
          aspectRatio,
          duration,
          quality,
          characterImage: state.bulkCharacterImage ? { ...state.bulkCharacterImage } : null,
          productImage: { ...prodImg, id: streamId },
          referenceImage: null,
          linkedImageRowId: "",
          accountId,
          accountName,
          status: "idle",
          mediaUrl: "",
          filename: "",
          error: "",
        });
      }

      sortBatchRowsByStream();
      renderProductChips();
      saveBatchRows();
      renderBatchTable();
      showToast(
        `Đã thêm ${loadedObjs.length} sản phẩm mới (Giữ nguyên toàn bộ luồng cũ, Tổng: ${state.batchRows.length} Luồng)!`
      );
    };

    // Drag & Drop Product Images anywhere onto the Batch View / Product Dropzone
    const batchViewEl = $("#view-batch");
    if (batchViewEl) {
      batchViewEl.addEventListener("dragover", (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      });
      batchViewEl.addEventListener("drop", async (e) => {
        const files = Array.from(e.dataTransfer?.files || []).filter(
          (f) => f.type && f.type.startsWith("image/")
        );
        if (!files.length) return;
        e.preventDefault();
        await addBulkProductsAndCreateStreams(files);
      });
    }

    $("#btnClearBulkProduct")?.addEventListener("click", async () => {
      const running = state.batchRows.filter(
        (r) => r.status === "running" || activeClientRowIds.has(r.id)
      );
      if (running.length > 0) {
        await stopRows(running, { silent: true, cancelAllServer: true });
      }
      state.bulkProductImages = [];
      state.bulkProductImage = null;
      state.batchRows = [];
      renderProductChips();
      saveBatchRows();
      renderBatchTable();
      showToast("Đã xóa toàn bộ danh sách sản phẩm & luồng.");
    });

    $("#bulkProductListBox")?.addEventListener("click", (e) => {
      const rmBtn = e.target.closest("[data-remove-bulk-prod]");
      if (!rmBtn) return;
      const rowId = rmBtn.dataset.removeBulkRow;
      if (rowId) {
        const chipRow = state.batchRows.find((r) => r.id === rowId);
        if (chipRow && (chipRow.status === "running" || activeClientRowIds.has(chipRow.id))) {
          stopRows([chipRow], { silent: true });
        }
        state.batchRows = state.batchRows.filter((r) => r.id !== rowId);
      } else {
        const idx = Number(rmBtn.dataset.removeBulkProd);
        if (!Number.isNaN(idx) && state.bulkProductImages[idx]) {
          const targetProdId = state.bulkProductImages[idx].id;
          state.batchRows = state.batchRows.filter(
            (r) => r.streamId !== targetProdId && r.productImage?.id !== targetProdId
          );
        }
      }
      sortBatchRowsByStream();
      renderProductChips();
      saveBatchRows();
      renderBatchTable();
    });

    $("#btnUploadScriptProduct")?.addEventListener("click", () => {
      state.pendingProductTarget = "script";
      const input = $("#hiddenProductImageInput");
      if (input) {
        input.multiple = true;
        input.click();
      }
    });
    $("#btnClearScriptProduct")?.addEventListener("click", () => {
      state.scriptProductImages = [];
      state.scriptProductImage = null;
      renderProductChips();
      showToast("Đã xóa toàn bộ sản phẩm trong mục tạo kịch bản.");
    });

    $("#scriptProductListBox")?.addEventListener("click", (e) => {
      const rmBtn = e.target.closest("[data-remove-script-prod]");
      if (!rmBtn) return;
      const idx = Number(rmBtn.dataset.removeScriptProd);
      if (!Number.isNaN(idx)) {
        state.scriptProductImages.splice(idx, 1);
        renderProductChips();
      }
    });

    $("#hiddenProductImageInput")?.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (!files.length || !state.pendingProductTarget) return;
      const target = state.pendingProductTarget;

      if (target === "bulk") {
        await addBulkProductsAndCreateStreams(files);
      } else if (target === "script") {
        const loadedObjs = await readFilesAsProductObjs(files);
        state.scriptProductImages.push(...loadedObjs);
        renderProductChips();
        const totalSp = state.scriptProductImages.length;
        showToast(
          `Đã đính kèm ${loadedObjs.length} sản phẩm (Tổng: ${totalSp} Luồng SP) cho AI viết kịch bản!`
        );
      } else {
        const loadedObjs = await readFilesAsProductObjs(files);
        const row = state.batchRows.find((r) => r.id === target);
        if (row && loadedObjs[0]) {
          row.productImage = loadedObjs[0];
          sortBatchRowsByStream();
          renderProductChips();
          saveBatchRows();
          renderBatchTable();
          showToast(`Đã gắn ảnh Sản phẩm [${loadedObjs[0].name}] vào dòng!`);
        }
      }
    });

    $("#selectAllBatch")?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      visibleRows().forEach((r) => {
        r.selected = checked;
      });
      renderBatchTable();
    });

    $("#btnQueueAddRow")?.addEventListener("click", () => {
      addOneStreamFromPrompt({ focusPreview: true });
    });

    $("#btnSelectAllRows")?.addEventListener("click", () => {
      visibleRows().forEach((r) => {
        r.selected = true;
      });
      renderBatchTable();
    });

    $("#btnUnselectAll")?.addEventListener("click", () => {
      state.batchRows.forEach((r) => {
        r.selected = false;
      });
      renderBatchTable();
    });

    $("#btnSelectRunning")?.addEventListener("click", () =>
      selectVisible((r) => r.status === "running" || activeClientRowIds.has(r.id))
    );

    $("#btnBulkApplyPrompt")?.addEventListener("click", () => {
      bulkApplyPromptToSelected();
    });

    $("#btnStopSelectedBatch")?.addEventListener("click", () => {
      stopSelectedBatch();
    });

    $("#btnStopAllBatch")?.addEventListener("click", () => {
      stopAllBatch();
    });

    $("#btnDeleteSelectedBatch")?.addEventListener("click", async () => {
      const selectedRows = state.batchRows.filter((r) => r.selected);
      if (!selectedRows.length) {
        showToast("Chưa chọn luồng nào để xoá!", true);
        return;
      }
      const runningSelected = selectedRows.filter(
        (r) => r.status === "running" || activeClientRowIds.has(r.id)
      );
      if (runningSelected.length > 0) {
        await stopRows(runningSelected, { silent: true });
      }
      const before = state.batchRows.length;
      state.batchRows = state.batchRows.filter((r) => !r.selected);
      sortBatchRowsByStream();
      renderProductChips();
      saveBatchRows();
      renderBatchTable();
      showToast(`Đã xóa ${before - state.batchRows.length} luồng đã chọn.`);
    });

    $("#btnRunSelectedBatch")?.addEventListener("click", async () => {
      if (state.batchRows.length === 0) {
        createStreamsFromPrompt();
      }
      await runSelectedBatch();
    });
    $("#btnDownloadSelectedBatch")?.addEventListener("click", () => downloadSelectedBatch());
    $("#btnRetryErrored")?.addEventListener("click", () => retryErroredRows());
    $("#btnSelectErrored")?.addEventListener("click", () => selectVisible((r) => r.status === "error"));
    $("#btnSelectPending")?.addEventListener("click", () => selectVisible((r) => !r.status || r.status === "idle"));
    $("#queueSearch")?.addEventListener("input", (e) => {
      state.queueFilter.q = e.target.value;
      renderBatchTable();
    });
    $("#queueStatusFilter")?.addEventListener("change", (e) => {
      state.queueFilter.status = e.target.value;
      renderBatchTable();
    });
    for (const radio of document.querySelectorAll('input[name="queueView"]')) {
      radio.checked = radio.value === state.queueView;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        state.queueView = radio.value;
        localStorage.setItem("muse_queue_view", state.queueView);
        renderBatchTable();
      });
    }
    bindSegToSelect("bulkModeTab", "bulkModeSelect");
    bindSegToSelect("bulkAspectTab", "bulkAspectSelect");

    const openFolderHandler = async () => {
      if (window.embongDesktop && window.embongDesktop.openMediaFolder) {
        await window.embongDesktop.openMediaFolder();
      } else {
        switchView("media");
      }
    };
    $("#btnOpenMediaFolder")?.addEventListener("click", openFolderHandler);
    $("#btnOpenMediaFolderGallery")?.addEventListener("click", openFolderHandler);

    // Table delegations
    $(".studio")?.addEventListener("input", (e) => {
      const t = e.target;
      const id = t.dataset.id;
      const row = state.batchRows.find((r) => r.id === id);
      if (!row) return;
      if (t.classList.contains("row-prompt-input")) {
        row.prompt = t.value;
        const listText = document.querySelector(`.queue-item[data-row-id="${id}"] .queue-prompt`);
        if (listText) listText.textContent = shortPrompt(t.value) || "Chưa có prompt";
        scheduleSaveBatchRows();
      }
    });

    $(".studio")?.addEventListener("change", (e) => {
      const t = e.target;
      const id = t.dataset.id;
      const row = state.batchRows.find((r) => r.id === id);
      if (!row) return;

      if (t.classList.contains("row-check")) {
        row.selected = t.checked;
        renderBatchTable();
      } else if (t.classList.contains("row-mode-select")) {
        row.mode = t.value;
        row.stepOrder = row.mode === "image" ? 1 : 2;
        saveBatchRows();
        renderBatchTable();
      } else if (t.classList.contains("row-aspect-select")) {
        row.aspectRatio = t.value;
        saveBatchRows();
        renderBatchTable();
      } else if (t.classList.contains("row-duration-select")) {
        row.duration = t.value;
        saveBatchRows();
        renderBatchTable();
      } else if (t.classList.contains("row-quality-select")) {
        row.quality = t.value;
        saveBatchRows();
        renderBatchTable();
      }
    });

    $(".studio")?.addEventListener("click", async (e) => {
      const checkEl = e.target.closest(".row-check");
      if (checkEl) {
        const clickedId = checkEl.dataset.id;
        if (e.shiftKey && lastClickedCheckRowId && lastClickedCheckRowId !== clickedId) {
          const vis = visibleRows();
          const i1 = vis.findIndex((r) => r.id === lastClickedCheckRowId);
          const i2 = vis.findIndex((r) => r.id === clickedId);
          if (i1 >= 0 && i2 >= 0) {
            const [start, end] = i1 < i2 ? [i1, i2] : [i2, i1];
            const targetState = checkEl.checked;
            for (let i = start; i <= end; i += 1) {
              vis[i].selected = targetState;
            }
            renderBatchTable();
          }
        }
        lastClickedCheckRowId = clickedId;
        return;
      }

      const opener = e.target.closest("[data-preview-id]");
      if (opener) {
        state.previewRowId = opener.dataset.previewId;
        renderBatchTable();
        return;
      }
      if (e.target.closest("[data-empty-create-from-prompt]")) {
        createStreamsFromPrompt();
        return;
      }
      if (e.target.closest("[data-empty-upload-products]")) {
        triggerBulkProductUpload();
        return;
      }
      const btn = e.target.closest("[data-row-action]");
      if (!btn) return;
      const action = btn.dataset.rowAction;
      const id = btn.dataset.id;
      const row = state.batchRows.find((r) => r.id === id);
      if (!row) return;

      if (action === "run") {
        runSingleRow(row);
      } else if (action === "stop") {
        await stopRows([row]);
      } else if (action === "restart") {
        await stopRows([row], { silent: true });
        runSingleRow(row);
      } else if (action === "edit") {
        state.previewRowId = row.id;
        renderBatchTable();
        const promptInput = $("#previewPrompt");
        if (promptInput) {
          promptInput.focus();
          promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
        }
      } else if (action === "delete") {
        if (row.status === "running" || activeClientRowIds.has(row.id)) {
          await stopRows([row], { silent: true });
        }
        state.batchRows = state.batchRows.filter((r) => r.id !== id);
        sortBatchRowsByStream();
        renderProductChips();
        saveBatchRows();
        renderBatchTable();
        showToast("Đã xoá luồng khỏi hàng đợi.");
      } else if (action === "upload-character") {
        state.pendingCharacterTarget = id;
        $("#hiddenCharacterImageInput")?.click();
      } else if (action === "clear-character") {
        row.characterImage = null;
        saveBatchRows();
        renderBatchTable();
      } else if (action === "preview-character" && row.characterImage?.dataUrl) {
        openMediaPreview(
          row.characterImage.dataUrl,
          "image",
          `Ảnh Nhân vật: ${row.characterImage.name || "Character"}`
        );
      } else if (action === "upload-product") {
        state.pendingProductTarget = id;
        const input = $("#hiddenProductImageInput");
        if (input) {
          input.multiple = false;
          input.click();
        }
      } else if (action === "clear-product") {
        row.productImage = null;
        sortBatchRowsByStream();
        renderProductChips();
        saveBatchRows();
        renderBatchTable();
      } else if (action === "preview-product" && row.productImage?.dataUrl) {
        openMediaPreview(
          row.productImage.dataUrl,
          "image",
          `Ảnh Sản phẩm: ${row.productImage.name || "Product"}`
        );
      } else if (action === "upload-ref") {
        state.pendingImageRowId = id;
        $("#hiddenRowImageInput")?.click();
      } else if (action === "clear-ref") {
        row.referenceImage = null;
        row.linkedImageRowId = "";
        saveBatchRows();
        renderBatchTable();
      } else if (action === "preview-ref" && row.referenceImage?.dataUrl) {
        openMediaPreview(row.referenceImage.dataUrl, "image", row.referenceImage.name || "Ảnh mẫu");
      } else if (action === "preview-media" && row.mediaUrl) {
        openMediaPreview(row.mediaUrl, row.mode, row.filename || "Kết quả Media");
      }
    });

    $("#hiddenRowImageInput")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !state.pendingImageRowId) return;
      const row = state.batchRows.find((r) => r.id === state.pendingImageRowId);
      if (!row) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const comma = dataUrl.indexOf(",");
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        row.referenceImage = {
          name: file.name,
          mime: file.type || "image/png",
          dataUrl,
          b64,
        };
        saveBatchRows();
        renderBatchTable();
        showToast(`Đã gắn ảnh khung đầu [${file.name}] vào dòng!`);
      };
      reader.readAsDataURL(file);
    });

    // Show & Hide Chrome Window buttons
    const showChromeHandler = async () => {
      try {
        showToast("Đang sắp xếp gọn & hiển thị các cửa sổ Chrome trên màn hình...");
        await api("/admin/chrome/show", { method: "POST" });
        updateChromeVisibilityButtons(true);
        await loadStatus();
        showToast("Đã xếp gọn và hiển thị các cửa sổ Chrome dạng lưới nhỏ!");
      } catch (err) {
        showToast(`Lỗi hiện Chrome: ${err.message}`, true);
      }
    };
    const hideChromeHandler = async () => {
      try {
        await api("/admin/chrome/hide", { method: "POST" });
        updateChromeVisibilityButtons(false);
        await loadStatus();
        showToast("Đã ẩn hoàn toàn cửa sổ Chrome khỏi màn hình (Vẫn chạy ngầm 100% tốc độ)!");
      } catch (err) {
        showToast(`Lỗi ẩn Chrome: ${err.message}`, true);
      }
    };
    $("#btnShowChromeWindow")?.addEventListener("click", showChromeHandler);
    $("#btnSideShowChrome")?.addEventListener("click", showChromeHandler);
    $("#btnHideChromeWindow")?.addEventListener("click", hideChromeHandler);
    $("#btnSideHideChrome")?.addEventListener("click", hideChromeHandler);

    // Accounts Actions
    $("#btnAddAccountManual")?.addEventListener("click", async () => {
      const name = $("#accNameInput")?.value.trim() || "";
      const cookies = $("#accCookieInput")?.value.trim() || "";
      if (!cookies) {
        showToast("Vui lòng dán dữ liệu Cookie Muse.ai!", true);
        return;
      }
      const btn = $("#btnAddAccountManual");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${ICON.spinner}<span>Đang lưu &amp; mở Chrome check LIVE/DIE...</span>`;
      }
      try {
        const res = await api("/admin/accounts", {
          method: "POST",
          body: { name, cookies, autoCheck: true },
        });
        $("#accNameInput").value = "";
        $("#accCookieInput").value = "";
        if (res.check && !res.check.ok) {
          showToast(
            `Ních [${res.account.name}] báo DIE (Không dùng được): ${res.check.error}`,
            true
          );
        } else {
          showToast(
            `Ních [${res.account.name}] đang LIVE (Dùng được)! (${res.account.cookie_count} cookies)`
          );
        }
        await loadAccounts();
        await loadStatus();
      } catch (err) {
        showToast(err.message, true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${ICON.plus}<span>Lưu &amp; Check LIVE/DIE ngay</span>`;
        }
      }
    });

    let pendingBrowserLogins = 0;
    const updateBrowserLoginButtonLabel = () => {
      const btn = $("#btnBrowserLoginCookie");
      if (!btn) return;
      if (pendingBrowserLogins > 0) {
        btn.innerHTML = `${ICON.spinner}<span>Mở thêm Chrome đăng nhập (Đang chờ ${pendingBrowserLogins} cửa sổ...)</span>`;
      } else {
        btn.innerHTML = `${ICON.globe}<span>Mở Chrome đăng nhập (Tự lấy Cookie)</span>`;
      }
    };

    $("#btnBrowserLoginCookie")?.addEventListener("click", async () => {
      const baseName = $("#accNameInput")?.value.trim() || "";
      const count = Math.max(1, Math.min(8, Number($("#multiLoginCountSelect")?.value || 1)));

      showToast(
        count > 1
          ? `Đang mở ${count} cửa sổ Chrome độc lập (Profile riêng) để bạn đăng nhập ${count} ních Muse.ai cùng lúc!`
          : "Đang mở cửa sổ Chrome độc lập! Hãy đăng nhập tài khoản Muse.ai, tool sẽ tự bắt Cookie & thêm ních mới..."
      );

      for (let i = 0; i < count; i += 1) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 700));
        }
        const winName = baseName && count > 1 ? `${baseName} #${i + 1}` : baseName;
        pendingBrowserLogins += 1;
        updateBrowserLoginButtonLabel();

        api("/admin/accounts/browser-login", {
          method: "POST",
          body: {
            name: winName,
            forceNewProfile: true,
            slotOffset: i,
            timeoutSec: 240,
          },
        })
          .then(async (res) => {
            showToast(
              `Đã lưu [${res.account.name}] LIVE (Profile :${res.cdp_port || res.account.cdp_port || 9225}) — ${res.cookie_count} cookies!`
            );
            await loadAccounts();
            await loadStatus();
          })
          .catch((err) => {
            showToast(`Lỗi lấy Cookie từ Chrome: ${err.message}`, true);
          })
          .finally(() => {
            pendingBrowserLogins = Math.max(0, pendingBrowserLogins - 1);
            updateBrowserLoginButtonLabel();
          });
      }
    });

    $("#btnRenewAllAccounts")?.addEventListener("click", async () => {
      const btn = $("#btnRenewAllAccounts");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${ICON.spinner}<span>Đang Check LIVE / DIE tất cả ních...</span>`;
      }
      showToast("Đang mở Chrome kiểm tra LIVE / DIE và gia hạn 48h cho toàn bộ ních...");
      try {
        const res = await api("/admin/accounts/renew-all", { method: "POST" });
        const results = res.results || [];
        const liveCount = results.filter((r) => r.ok).length;
        const dieCount = results.length - liveCount;
        showToast(
          `Kiểm tra hoàn tất: ${liveCount} ních LIVE · ${dieCount} ních DIE!`,
          dieCount > 0 && liveCount === 0
        );
        await loadAccounts();
        await loadStatus();
      } catch (err) {
        showToast(err.message, true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${ICON.refresh}<span>Check LIVE / DIE tất cả (+48h)</span>`;
        }
      }
    });

    $("#accountsTableBody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-acc-action]");
      if (!btn) return;
      const action = btn.dataset.accAction;
      const id = btn.dataset.id;

      try {
        if (action === "delete") {
          await api(`/admin/accounts/${id}`, { method: "DELETE" });
          showToast("Đã xóa ních.");
        } else if (action === "toggle") {
          await api(`/admin/accounts/${id}/toggle`, { method: "POST" });
        } else if (action === "open-chrome") {
          btn.disabled = true;
          btn.innerHTML = `${ICON.spinner}<span>Đang mở...</span>`;
          showToast("Đang mở cửa sổ Chrome riêng của ních này...");
          const r = await api(`/admin/accounts/${id}/open-chrome`, { method: "POST" });
          if (r.ok) {
            showToast(
              `Đã mở & đồng bộ [${r.account?.name || id}] LIVE trên Chrome (:${r.cdp_port || 9225})!`
            );
          }
        } else if (action === "renew") {
          btn.disabled = true;
          btn.innerHTML = `${ICON.spinner}<span>Check...</span>`;
          const r = await api(`/admin/accounts/${id}/renew`, { method: "POST" });
          if (r.ok) {
            showToast(
              `Ních LIVE (Dùng được)! VM: ${r.vm_state || "RUNNING"}, hạn Cookie: ${r.expires_in_hours || 48}h`
            );
          } else {
            showToast(`Ních DIE (Không dùng được): ${r.error}`, true);
          }
        } else if (action === "quota") {
          btn.disabled = true;
          btn.innerHTML = `${ICON.spinner}`;
          const r = await api(`/admin/accounts/${id}/quota`, { method: "POST" });
          if (r.ok) {
            showToast(`Quota đã dùng: ${r.quota.used_percent}`);
          } else {
            showToast(`Lỗi kiểm tra Quota: ${r.error}`, true);
          }
        }
        await loadAccounts();
        await loadStatus();
      } catch (err) {
        showToast(err.message, true);
        await loadAccounts();
      }
    });

    // Chat & Script Generator
    const sendChatHandler = async () => {
      const input = $("#chatPromptInput");
      const box = $("#chatMessagesBox");
      const prompt = input?.value.trim() || "";
      if (!prompt || !box) return;
      input.value = "";

      const userDiv = document.createElement("div");
      userDiv.className = "chat-msg user";
      userDiv.textContent = prompt;
      box.appendChild(userDiv);

      const botDiv = document.createElement("div");
      botDiv.className = "chat-msg assistant";
      botDiv.textContent = "Muse-Spark đang suy nghĩ...";
      box.appendChild(botDiv);
      box.scrollTop = box.scrollHeight;

      const model = $("#chatModelSelect")?.value || "muse-spark";
      try {
        const res = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: true,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullText = "";
        botDiv.textContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          for (const line of chunkStr.split("\n")) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const payload = JSON.parse(line.slice(6));
                const delta = payload.choices?.[0]?.delta?.content || "";
                if (delta) {
                  fullText += delta;
                  botDiv.textContent = fullText;
                  box.scrollTop = box.scrollHeight;
                }
              } catch (_err) {
                // ignore
              }
            }
          }
        }
        if (!fullText) botDiv.textContent = "(Không có nội dung trả về)";
      } catch (err) {
        botDiv.textContent = `Lỗi: ${err.message}`;
      }
    };

    $("#btnSendChat")?.addEventListener("click", sendChatHandler);
    $("#chatPromptInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChatHandler();
    });
    $("#btnClearChat")?.addEventListener("click", () => {
      const box = $("#chatMessagesBox");
      if (box) box.innerHTML = "";
    });

    $("#scriptProviderSelect")?.addEventListener("change", (e) => {
      const isGemini = e.target.value === "gemini";
      if ($("#geminiKeyConfigBox")) {
        $("#geminiKeyConfigBox").style.display = isGemini ? "block" : "none";
      }
      if ($("#scriptGeminiModelSelect")) {
        $("#scriptGeminiModelSelect").disabled = !isGemini;
      }
    });

    $("#btnTestGeminiKey")?.addEventListener("click", async () => {
      const apiKey = $("#scriptGeminiKeyInput")?.value.trim() || "";
      const model = $("#scriptGeminiModelSelect")?.value || "gemini-2.5-flash";
      if (!apiKey) {
        showToast("Vui lòng nhập Google Gemini API Key (AIzaSy...)!", true);
        return;
      }
      const btn = $("#btnTestGeminiKey");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${ICON.spinner}<span>Đang kiểm tra...</span>`;
      }
      try {
        const res = await api("/admin/ai/test-gemini", {
          method: "POST",
          body: { apiKey, model },
        });
        if ($("#setGeminiApiKey")) $("#setGeminiApiKey").value = apiKey;
        showToast(`Gemini API Key hoạt động tốt (${res.model})! Đã lưu tự động.`);
      } catch (err) {
        showToast(`Lỗi Gemini API Key: ${err.message}`, true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${ICON.check}<span>Lưu &amp; Test Key</span>`;
        }
      }
    });

    $("#btnGenerateScriptPrompts")?.addEventListener("click", async () => {
      const topic = $("#scriptTopicInput")?.value.trim() || "";
      if (!topic) {
        showToast("Vui lòng nhập chủ đề kịch bản!", true);
        return;
      }
      const provider = $("#scriptProviderSelect")?.value || "gemini";
      const apiKey =
        $("#scriptGeminiKeyInput")?.value.trim() ||
        $("#setGeminiApiKey")?.value.trim() ||
        "";
      const model = $("#scriptGeminiModelSelect")?.value || "gemini-2.5-flash";
      const count = Number($("#scriptCountSelect")?.value || 3);
      const mode = $("#scriptTargetMode")?.value || "video";
      const duration = $("#scriptDurationSelect")?.value || "20s";
      const quality = $("#scriptQualitySelect")?.value || "4K";

      if (provider === "gemini" && !apiKey) {
        showToast(
          "Vui lòng dán Google Gemini API Key vào ô phía trên (hoặc đổi sang nguồn Muse-Spark)!",
          true
        );
        $("#scriptGeminiKeyInput")?.focus();
        return;
      }

      const btn = $("#btnGenerateScriptPrompts");
      const outBox = $("#scriptResultOutput");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML =
          provider === "gemini"
            ? `${ICON.spinner}<span>Gemini (${escapeHtml(model)}) đang phân tích &amp; viết kịch bản...</span>`
            : `${ICON.spinner}<span>Muse-Spark đang viết kịch bản...</span>`;
      }

      try {
        const prodList =
          state.scriptProductImages.length > 0
            ? state.scriptProductImages
            : state.bulkProductImages;
        const res = await api("/admin/ai/generate-script", {
          method: "POST",
          body: {
            provider,
            apiKey,
            model,
            topic,
            count,
            mode,
            duration,
            quality,
            characterImage: state.scriptCharacterImage
              ? {
                  b64: state.scriptCharacterImage.b64,
                  mime: state.scriptCharacterImage.mime,
                  name: state.scriptCharacterImage.name,
                }
              : null,
            productImages: prodList.map((p) => ({
              b64: p.b64,
              mime: p.mime,
              name: p.name,
            })),
          },
        });
        if (outBox) {
          outBox.value = Array.isArray(res.prompts)
            ? res.prompts.join("\n")
            : res.text || "";
        }
        const vidLines =
          Array.isArray(res.videoPrompts) && res.videoPrompts.length
            ? res.videoPrompts
            : Array.isArray(res.prompts)
            ? res.prompts
            : [];
        if (vidLines.length) loadPromptsIntoInput(vidLines);
        if (apiKey && $("#setGeminiApiKey")) {
          $("#setGeminiApiKey").value = apiKey;
        }
        showToast(
          `Đã tạo xong kịch bản bằng ${
            res.provider === "gemini" ? `Google Gemini (${res.model})` : "Muse-Spark"
          } và tự nạp vào Prompt Cố Định!`
        );
      } catch (err) {
        showToast(`Lỗi tạo kịch bản AI: ${err.message}`, true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `${ICON.sparkles}<span>Tạo kịch bản bằng AI (Gemini / Muse-Spark)</span>`;
        }
      }
    });

    const pushScriptToBatchTable = () => {
      const lines = window.MusePromptLines.splitPromptLines($("#scriptResultOutput")?.value);
      if (!lines.length) {
        showToast("Chưa có nội dung Prompt Video nào để đẩy sang bảng!", true);
        return false;
      }
      const duration = $("#scriptDurationSelect")?.value || "20s";
      const quality = $("#scriptQualitySelect")?.value || "4K";

      loadPromptsIntoInput(lines);

      if ($("#bulkDurationSelect")) $("#bulkDurationSelect").value = duration;
      if ($("#bulkQualitySelect")) $("#bulkQualitySelect").value = quality;

      if (state.scriptCharacterImage) {
        state.bulkCharacterImage = { ...state.scriptCharacterImage };
        if ($("#bulkCharacterThumb")) $("#bulkCharacterThumb").src = state.bulkCharacterImage.dataUrl;
        if ($("#bulkCharacterName")) $("#bulkCharacterName").textContent = state.bulkCharacterImage.name;
        if ($("#bulkCharacterPreviewBox")) $("#bulkCharacterPreviewBox").style.display = "inline-flex";
      }

      if (state.scriptProductImages.length > 0) {
        const fixedVidPrompt = getFixedVideoPrompt() || DEFAULT_FIXED_VIDEO_PROMPT;
        const aspectRatio = $("#bulkAspectSelect")?.value || "9:16";
        const accountId = $("#bulkAccountSelect")?.value || "";
        const accObj = state.accounts.find((a) => a.id === accountId);
        const accountName = accObj ? accObj.name : "Tự động LRU";

        for (const r of state.batchRows) {
          if (r.status === "done") r.selected = false;
        }

        for (const prodImg of state.scriptProductImages) {
          const nextIdx = state.batchRows.length + 1;
          const streamId = prodImg.id || `stream_sp_${Date.now()}_${nextIdx}`;
          const shortName = (prodImg.name || `SP ${nextIdx}`).replace(/\.[^.]+$/, "").slice(0, 18);
          state.batchRows.push({
            id: uid(),
            selected: true,
            streamId,
            streamIndex: nextIdx,
            streamLabel: `Luồng SP #${nextIdx} (${shortName})`,
            stepOrder: 1,
            mode: "video",
            prompt: fixedVidPrompt,
            aspectRatio,
            duration,
            quality,
            characterImage: state.bulkCharacterImage ? { ...state.bulkCharacterImage } : null,
            productImage: { ...prodImg, id: streamId },
            referenceImage: null,
            linkedImageRowId: "",
            accountId,
            accountName,
            status: "idle",
            mediaUrl: "",
            filename: "",
            error: "",
          });
        }
      }

      syncStreamsFromProducts({ preserveFinished: true });
      switchView("batch");
      const spCount = state.batchRows.length;
      if (spCount > 0) {
        showToast(
          `Đã cập nhật Prompt Video Cố Định & sẵn sàng ${spCount} Luồng tạo Video!`
        );
      } else {
        showToast(
          `Đã lưu vào Prompt Video Cố Định! Hãy ném Ảnh Sản phẩm vào để tạo Luồng Video chạy ngay.`
        );
      }
      return spCount > 0;
    };

    $("#btnPushScriptToBatch")?.addEventListener("click", () => {
      pushScriptToBatchTable();
    });

    $("#btnPushAndRunScriptBatch")?.addEventListener("click", async () => {
      const ok = pushScriptToBatchTable();
      if (ok) {
        await runSelectedBatch();
      }
    });

    // Media Gallery
    $("#mediaFilterSelect")?.addEventListener("change", () => renderMediaGallery());
    $("#btnRefreshMedia")?.addEventListener("click", () => loadMedia());
    $("#mediaGalleryGrid")?.addEventListener("click", async (e) => {
      const prev = e.target.closest("[data-media-preview]");
      if (prev) {
        openMediaPreview(
          prev.dataset.mediaPreview,
          prev.dataset.mediaType,
          prev.dataset.mediaName
        );
        return;
      }
      const del = e.target.closest("[data-media-delete]");
      if (del) {
        const name = del.dataset.mediaDelete;
        await api(`/admin/media/${encodeURIComponent(name)}`, { method: "DELETE" });
        showToast(`Đã xóa ${name}`);
        loadMedia();
        loadStatus();
      }
    });

    // Tasks & Logs
    $("#btnRefreshTasks")?.addEventListener("click", () => loadTasksAndLogs());
    $("#btnClearTasks")?.addEventListener("click", async () => {
      await api("/admin/tasks", { method: "DELETE" });
      showToast("Đã xóa lịch sử tiến trình.");
      loadTasksAndLogs();
      loadStatus();
    });

    // API & Settings
    $("#btnCopyBaseUrl")?.addEventListener("click", () => {
      navigator.clipboard.writeText($("#apiBaseUrlInput")?.value || "");
      showToast("Đã sao chép OpenAI Base URL!");
    });
    $("#btnCopyApiKey")?.addEventListener("click", () => {
      navigator.clipboard.writeText($("#apiKeyInput")?.value || "");
      showToast("Đã sao chép API Key!");
    });
    $("#btnRotateApiKey")?.addEventListener("click", async () => {
      const res = await api("/admin/apikey/rotate", { method: "POST" });
      if ($("#apiKeyInput")) $("#apiKeyInput").value = res.api_key;
      await loadStatus();
      showToast("Đã tạo API Key mới!");
    });
    $("#btnSaveSettings")?.addEventListener("click", async () => {
      const geminiKey =
        $("#setGeminiApiKey")?.value.trim() ||
        $("#scriptGeminiKeyInput")?.value.trim() ||
        "";
      await api("/admin/settings", {
        method: "POST",
        body: {
          maxConcurrency: Number($("#setMaxConcurrency")?.value || 3),
          keepaliveIntervalMinutes: Number($("#setKeepaliveMin")?.value || 360),
          genTimeout: Number($("#setGenTimeout")?.value || 180),
          videoTimeout: Number($("#setVideoTimeout")?.value || 600),
          geminiApiKey: geminiKey,
          geminiModel: $("#scriptGeminiModelSelect")?.value || "gemini-2.5-flash",
        },
      });
      if (geminiKey && $("#scriptGeminiKeyInput")) {
        $("#scriptGeminiKeyInput").value = geminiKey;
      }
      showToast("Đã lưu cấu hình hệ thống & Gemini API Key!");
      loadStatus();
    });

    // Modal close
    $("#modalCloseBtn")?.addEventListener("click", () => {
      $("#mediaPreviewModal")?.classList.add("hidden");
      if ($("#modalMediaBody")) $("#modalMediaBody").innerHTML = "";
    });
    $("#mediaPreviewModal")?.addEventListener("click", (e) => {
      if (e.target.id === "mediaPreviewModal") {
        $("#mediaPreviewModal")?.classList.add("hidden");
        if ($("#modalMediaBody")) $("#modalMediaBody").innerHTML = "";
      }
    });

    // ==================== COMMUNITY & DONATE COFFEE EVENTS ====================
    const openExternalLink = async (url) => {
      if (!url) return;
      try {
        if (window.embongDesktop && typeof window.embongDesktop.openExternal === "function") {
          await window.embongDesktop.openExternal(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      } catch (_e) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    };

    document.addEventListener("click", (e) => {
      const extBtn = e.target.closest("[data-external-url]");
      if (extBtn) {
        e.preventDefault();
        const url = extBtn.getAttribute("data-external-url");
        openExternalLink(url);
        return;
      }

      const copyBtn = e.target.closest("[data-copy-text]");
      if (copyBtn) {
        e.preventDefault();
        const text = copyBtn.getAttribute("data-copy-text") || "";
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          showToast(`Đã sao chép: ${text} (EM BÔNG AI, MB BANK)!`);
        }
      }
    });

    const openWelcomeCoffeeModal = () => {
      $("#welcomeCoffeeModal")?.classList.remove("hidden");
    };
    const closeWelcomeCoffeeModal = () => {
      $("#welcomeCoffeeModal")?.classList.add("hidden");
    };

    $("#btnOpenWelcomeCoffeeModal")?.addEventListener("click", openWelcomeCoffeeModal);
    $("#btnShowQrModalTop")?.addEventListener("click", openWelcomeCoffeeModal);
    $("#btnOpenWelcomeModalFromCommunity")?.addEventListener("click", openWelcomeCoffeeModal);
    $("#sideCoffeeCard")?.addEventListener("click", () => {
      switchView("community");
    });

    $("#btnGoCommunityTop")?.addEventListener("click", () => {
      switchView("community");
    });

    $("#btnCopyBankTop")?.addEventListener("click", () => {
      navigator.clipboard.writeText("0843738866").catch(() => {});
      showToast("Đã sao chép STK: 0843738866 (MB BANK - EM BÔNG AI)!");
    });

    $("#btnCopySupportPhone")?.addEventListener("click", () => {
      navigator.clipboard.writeText("0843738866").catch(() => {});
      showToast("Đã sao chép SĐT Hỗ trợ: 0843738866!");
    });

    const zoomQrHandler = () => {
      openMediaPreview(
        "/assets/donate-qr-mbbank.png",
        "image",
        "Mời cafe EM BÔNG AI: 084.373.8866 MB BANK (TRAN LINH QUANG)"
      );
    };
    $("#btnZoomDonateQr")?.addEventListener("click", zoomQrHandler);
    $("#communityDonateQrImg")?.addEventListener("click", zoomQrHandler);

    $("#welcomeModalCloseBtn")?.addEventListener("click", closeWelcomeCoffeeModal);
    $("#btnWelcomeStartTool")?.addEventListener("click", closeWelcomeCoffeeModal);
    $("#btnWelcomeGoCommunity")?.addEventListener("click", () => {
      closeWelcomeCoffeeModal();
      switchView("community");
    });
    $("#welcomeCoffeeModal")?.addEventListener("click", (e) => {
      if (e.target.id === "welcomeCoffeeModal") {
        closeWelcomeCoffeeModal();
      }
    });
  }

  // ==================== INIT ====================
  async function init() {
    $all("textarea, input[type='text']").forEach((el) => {
      el.setAttribute("spellcheck", "false");
    });
    initFixedPrompts();
    applyTheme(state.theme);
    applyZoom(state.zoom);
    bindEvents();
    await Promise.all([loadStatus(), loadAccounts(), loadBatchRows()]);
    setInterval(() => {
      loadStatus();
    }, 2000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
