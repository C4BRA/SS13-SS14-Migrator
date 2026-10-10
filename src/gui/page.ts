// The convert GUI page (W-J). Kept as a template so the whole app stays a
// single self-contained asset served by GUIServer — no static-file plumbing
// in the build. Client JS is plain ES5-style: no backticks/${} so it can sit
// inside this template literal safely.
export interface PageOptions {
  authToken: string;
  defaultOutputPath: string;
  cores: number;
}

export function renderPage(opts: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dm2ss14 Convert</title>
<style>
:root {
  --bg: #0d1117; --card-bg: #161b22; --border: #30363d;
  --accent: #58a6ff; --accent-glow: rgba(88,166,255,0.25);
  --success: #3fb950; --warn: #d29922; --danger: #f85149;
  --text: #c9d1d9; --text-heading: #f0f6fc; --text-dim: #8b949e;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text);
  display: flex; justify-content: center;
  min-height: 100vh; padding: 20px;
}
.app-container {
  width: 100%; max-width: 920px; background: var(--card-bg);
  border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.6);
  display: flex; flex-direction: column; margin-bottom: 40px; height: fit-content;
}
.app-header {
  background: rgba(255,255,255,0.03); padding: 20px 32px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.app-title h1 { font-size: 22px; font-weight: 700; color: var(--text-heading); letter-spacing: -0.5px; }
.app-title p { font-size: 13px; color: var(--text-dim); margin-top: 4px; }
.status-badge {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--success);
  background: rgba(63,185,80,0.1); padding: 6px 12px; border-radius: 20px;
  border: 1px solid rgba(63,185,80,0.3); white-space: nowrap;
}
.status-badge.busy { color: var(--accent); background: var(--accent-glow); border-color: rgba(88,166,255,0.4); }
.status-dot { width: 8px; height: 8px; background: var(--success); border-radius: 50%; box-shadow: 0 0 8px var(--success); }
.status-badge.busy .status-dot { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.app-body { padding: 28px 32px; display: flex; flex-direction: column; gap: 20px; }
.section-label { font-size: 12px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.6px; }
.dropzone {
  border: 2px dashed #30363d; border-radius: 12px; padding: 34px 20px;
  text-align: center; background: rgba(0,0,0,0.2); cursor: pointer;
  transition: all 0.2s ease; display: flex; flex-direction: column;
  align-items: center; gap: 10px;
}
.dropzone:hover, .dropzone.dragover { border-color: var(--accent); background: var(--accent-glow); }
.dropzone * { pointer-events: none; }
.dropzone-icon { font-size: 36px; }
.dropzone-text { font-size: 15px; color: var(--text-heading); font-weight: 600; }
.dropzone-sub { font-size: 12px; color: var(--text-dim); }
.fields-row { display: grid; grid-template-columns: 1fr 190px; gap: 14px; }
.field-group { display: flex; flex-direction: column; gap: 8px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--text-heading); }
.field-input, .field-select {
  background: #0d1117; border: 1px solid var(--border); border-radius: 8px;
  padding: 11px 14px; color: #f0f6fc; font-size: 14px; width: 100%;
  outline: none; transition: border-color 0.2s;
}
.field-input:focus, .field-select:focus { border-color: var(--accent); }
.btn-row { display: flex; gap: 12px; }
.btn-convert {
  background: var(--accent); color: #0d1117; font-size: 15px; font-weight: 700;
  padding: 13px; border: none; border-radius: 8px; cursor: pointer; flex: 1;
  transition: all 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px;
}
.btn-convert:hover { opacity: 0.9; transform: translateY(-1px); box-shadow: 0 4px 16px var(--accent-glow); }
.btn-convert:disabled { background: #30363d; color: var(--text-dim); cursor: not-allowed; transform: none; box-shadow: none; }
.btn-cancel {
  background: rgba(248,81,73,0.12); color: var(--danger); font-size: 14px; font-weight: 700;
  padding: 13px 22px; border: 1px solid rgba(248,81,73,0.4); border-radius: 8px;
  cursor: pointer; display: none; transition: all 0.2s;
}
.btn-cancel:hover { background: rgba(248,81,73,0.25); }
.progress-strip { display: none; flex-direction: column; gap: 8px; }
.progress-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-dim); }
.progress-stage { color: var(--accent); font-weight: 600; }
.progress-track { height: 6px; background: #0d1117; border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
.progress-fill { height: 100%; width: 0%; background: var(--accent); border-radius: 4px; transition: width 0.4s ease; }
.log-box {
  background: #090d11; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px; color: #7ee787; height: 220px; overflow-y: auto; display: none;
  white-space: pre-wrap; word-break: break-word; line-height: 1.55;
}
.log-box .l-warn { color: var(--warn); }
.log-box .l-err { color: var(--danger); }
.log-box .l-dim { color: var(--text-dim); }
.card {
  border: 1px solid var(--border); border-radius: 10px; padding: 16px;
  display: none; flex-direction: column; gap: 12px; background: rgba(255,255,255,0.02);
}
.card.visible { display: flex; }
.card-title { font-size: 14px; font-weight: 700; color: var(--text-heading); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.stat-tile {
  background: #0d1117; border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 3px;
}
.stat-value { font-size: 19px; font-weight: 700; color: var(--text-heading); font-variant-numeric: tabular-nums; }
.stat-value.good { color: var(--success); }
.stat-value.bad { color: var(--danger); }
.stat-value.warn { color: var(--warn); }
.stat-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.4px; }
.stat-note { font-size: 11px; color: var(--text-dim); font-family: ui-monospace, monospace; word-break: break-word; }
.success-card {
  background: rgba(63,185,80,0.1); border: 1px solid rgba(63,185,80,0.3);
  border-radius: 10px; padding: 16px; display: none; flex-direction: column; gap: 8px;
}
.success-card.visible { display: flex; }
.success-title { font-size: 15px; font-weight: 700; color: var(--success); }
.success-cmd {
  background: #0d1117; padding: 10px; border-radius: 6px;
  font-family: monospace; font-size: 13px; color: #f0f6fc; border: 1px solid var(--border);
  word-break: break-all;
}
.browser-controls { display: flex; gap: 10px; }
.browser-controls .field-input { flex: 1; }
.btn-ghost {
  background: #0d1117; color: var(--accent); font-size: 13px; font-weight: 600;
  padding: 10px 16px; border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; transition: all 0.2s; white-space: nowrap;
}
.btn-ghost:hover { border-color: var(--accent); }
.breadcrumb { font-size: 12px; color: var(--text-dim); font-family: ui-monospace, monospace; word-break: break-all; }
.breadcrumb a { color: var(--accent); cursor: pointer; text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
.tree-list {
  background: #090d11; border: 1px solid var(--border); border-radius: 8px;
  max-height: 260px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px;
}
.tree-row {
  display: flex; justify-content: space-between; gap: 12px; padding: 5px 12px;
  cursor: pointer; border-bottom: 1px solid rgba(48,54,61,0.4);
}
.tree-row:hover { background: rgba(88,166,255,0.08); }
.tree-row .t-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-row .t-name.is-dir { color: var(--accent); font-weight: 600; }
.tree-row .t-size { color: var(--text-dim); flex-shrink: 0; }
.tree-empty { padding: 14px; color: var(--text-dim); text-align: center; }
.file-viewer { display: none; flex-direction: column; gap: 6px; }
.file-viewer.visible { display: flex; }
.file-head { font-size: 12px; color: var(--text-dim); font-family: ui-monospace, monospace; display: flex; justify-content: space-between; }
.file-text {
  background: #090d11; border: 1px solid var(--border); border-radius: 8px; padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px;
  color: var(--text); max-height: 340px; overflow: auto; white-space: pre; line-height: 1.5;
}
</style>
</head>
<body>
<div class="app-container">
  <div class="app-header">
    <div class="app-title">
      <h1>dm2ss14 Transpiler</h1>
      <p>Convert any SS13 repository .zip into a compilable SS14 server solution</p>
    </div>
    <div class="status-badge" id="statusBadge"><div class="status-dot"></div><span id="statusText">Ready</span></div>
  </div>
  <div class="app-body">
    <input type="file" id="fileInput" accept=".zip" style="display:none">
    <div class="dropzone" id="dropzone">
      <div class="dropzone-icon">&#x1F4E6;</div>
      <div class="dropzone-text" id="dropzoneText">Drop your SS13 repository .zip file here</div>
      <div class="dropzone-sub">or click to browse</div>
    </div>
    <div class="fields-row">
      <div class="field-group">
        <label class="field-label" for="outputPath">Output destination (inside your home directory)</label>
        <input type="text" id="outputPath" class="field-input" value="${opts.defaultOutputPath}">
      </div>
      <div class="field-group">
        <label class="field-label" for="jobsSelect">Worker jobs</label>
        <select id="jobsSelect" class="field-select">
          <option value="0" selected>Auto (${opts.cores} cores)</option>
          <option value="1">1 (sequential)</option>
          <option value="4">4</option>
          <option value="8">8</option>
        </select>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn-convert" id="convertBtn" disabled>Convert to SS14 Solution</button>
      <button class="btn-cancel" id="cancelBtn">Cancel</button>
    </div>
    <div class="progress-strip" id="progressStrip">
      <div class="progress-meta"><span class="progress-stage" id="progressStage">Starting&hellip;</span><span id="progressElapsed"></span></div>
      <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
    </div>
    <div class="log-box" id="logBox"></div>
    <div class="card" id="summaryCard">
      <div class="card-title">Fidelity summary</div>
      <div class="stat-grid" id="summaryGrid"></div>
      <div class="stat-note" id="summaryNote"></div>
    </div>
    <div class="success-card" id="successCard">
      <div class="success-title">&#x1F389; Conversion Complete!</div>
      <div>Your converted SS14 C# solution is ready at:</div>
      <div class="success-cmd" id="successPath"></div>
      <div>To launch the converted SS14 server:</div>
      <div class="success-cmd">dotnet run --project Content.Server</div>
    </div>
    <div class="card" id="browserCard">
      <div class="card-title">Output browser</div>
      <div class="browser-controls">
        <input type="text" id="browseRoot" class="field-input" value="${opts.defaultOutputPath}">
        <button class="btn-ghost" id="browseBtn">Browse</button>
      </div>
      <div class="breadcrumb" id="breadcrumb"></div>
      <div class="tree-list" id="treeList"><div class="tree-empty">Browse a converted output directory to inspect it here.</div></div>
      <div class="file-viewer" id="fileViewer">
        <div class="file-head"><span id="fileName"></span><span id="fileSize"></span></div>
        <div class="file-text" id="fileText"></div>
      </div>
    </div>
  </div>
</div>
<script>
(function() {
  var AUTH_TOKEN = "${opts.authToken}";
  var $ = function(id) { return document.getElementById(id); };
  var dropzone = $("dropzone"), fileInput = $("fileInput"), dropzoneText = $("dropzoneText");
  var convertBtn = $("convertBtn"), cancelBtn = $("cancelBtn"), outputPath = $("outputPath");
  var jobsSelect = $("jobsSelect"), logBox = $("logBox"), successCard = $("successCard");
  var successPath = $("successPath"), statusBadge = $("statusBadge"), statusText = $("statusText");
  var progressStrip = $("progressStrip"), progressStage = $("progressStage");
  var progressElapsed = $("progressElapsed"), progressFill = $("progressFill");
  var summaryCard = $("summaryCard"), summaryGrid = $("summaryGrid"), summaryNote = $("summaryNote");
  var browserCard = $("browserCard"), browseRoot = $("browseRoot"), browseBtn = $("browseBtn");
  var breadcrumb = $("breadcrumb"), treeList = $("treeList");
  var fileViewer = $("fileViewer"), fileName = $("fileName"), fileSize = $("fileSize"), fileText = $("fileText");
  var selectedFile = null, dragCounter = 0, es = null, converting = false, doneHandled = false;
  var convertStart = 0, elapsedTimer = null, browseRel = "";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function fmtBytes(n) {
    if (n === undefined || n === null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function fmtNum(n) {
    if (n === undefined || n === null) return "\u2014";
    return Number(n).toLocaleString("en-US");
  }

  function log(line, cls) {
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = line;
    logBox.appendChild(div);
    var nearBottom = logBox.scrollTop + logBox.clientHeight > logBox.scrollHeight - 80;
    if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
    while (logBox.childNodes.length > 3000) logBox.removeChild(logBox.firstChild);
  }
  function logLevelCls(level, line) {
    if (level === "error" || line.indexOf("[dm2ss14] error:") === 0) return "l-err";
    if (level === "warn" || line.indexOf("[dm2ss14] warning:") === 0) return "l-warn";
    return "";
  }

  function setBusy(b) {
    converting = b;
    statusBadge.className = b ? "status-badge busy" : "status-badge";
    statusText.textContent = b ? "Converting" : "Ready";
    convertBtn.disabled = b || !selectedFile;
    cancelBtn.style.display = b ? "block" : "none";
    progressStrip.style.display = b ? "flex" : "none";
    if (b) {
      convertStart = Date.now();
      progressElapsed.textContent = "0s";
      elapsedTimer = setInterval(function() {
        progressElapsed.textContent = Math.floor((Date.now() - convertStart) / 1000) + "s";
      }, 500);
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }
  function setStage(n, label) {
    progressStage.textContent = "Stage " + n + "/5 \u2014 " + label;
    progressFill.style.width = Math.min(100, (n / 5) * 100) + "%";
  }
  function watchStageLine(line) {
    var m = line.match(/\\[([1-5])\\/5\\]\\s*(.*)/);
    if (m) setStage(Number(m[1]), m[2]);
  }

  // Dropzone wiring (unchanged behavior).
  dropzone.addEventListener("click", function(e) { e.preventDefault(); e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener("change", function(e) {
    if (e.target.files && e.target.files.length > 0) { selectedFile = e.target.files[0]; showSelected(); }
  });
  dropzone.addEventListener("dragenter", function(e) { e.preventDefault(); e.stopPropagation(); dragCounter++; dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragover", function(e) { e.preventDefault(); e.stopPropagation(); });
  dropzone.addEventListener("dragleave", function(e) {
    e.preventDefault(); e.stopPropagation();
    dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropzone.classList.remove("dragover"); }
  });
  dropzone.addEventListener("drop", function(e) {
    e.preventDefault(); e.stopPropagation();
    dragCounter = 0; dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      selectedFile = e.dataTransfer.files[0]; showSelected();
    }
  });
  document.addEventListener("dragover", function(e) { e.preventDefault(); });
  document.addEventListener("drop", function(e) { e.preventDefault(); });
  function showSelected() {
    if (selectedFile) {
      dropzoneText.textContent = "\u2705 Selected: " + selectedFile.name;
      convertBtn.disabled = converting;
    }
  }

  function openEvents() {
    if (es) { es.close(); es = null; }
    es = new EventSource("/api/events?token=" + encodeURIComponent(AUTH_TOKEN));
    es.onmessage = function(ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "log") {
        log(msg.line, logLevelCls(msg.level, msg.line));
        watchStageLine(msg.line);
      } else if (msg.t === "running") {
        // Connected while a run is in flight — resume the busy UI so the
        // streamed lines land on a live stage bar and Cancel is offered.
        setBusy(true);
      } else if (msg.t === "done") {
        // A run we believe is in flight finished — only possible on a page
        // that joined mid-run (e.g. after reload); the run's own page settles
        // via the fetch response first and marks doneHandled.
        if (converting) finishRunUI(msg);
      } else if (msg.t === "start" && !msg.replay) {
        // A new run began after we connected — drop the previous run's
        // replayed history so the box shows this run only.
        doneHandled = false;
        logBox.innerHTML = "";
      }
    };
  }

  function tile(label, value, cls) {
    var d = document.createElement("div");
    d.className = "stat-tile";
    var v = document.createElement("div");
    v.className = "stat-value" + (cls ? " " + cls : "");
    v.textContent = (typeof value === "number") ? fmtNum(value) : String(value);
    var l = document.createElement("div");
    l.className = "stat-label";
    l.textContent = label;
    d.appendChild(v); d.appendChild(l);
    return d;
  }

  function renderSummary(s) {
    if (!s) return;
    summaryGrid.innerHTML = "";
    var add = function(label, value, cls) { if (value !== undefined && value !== null) summaryGrid.appendChild(tile(label, value, cls)); };
    add("DM files", s.dmFiles);
    add("DMI files", s.dmiFiles);
    add("DMM files", s.dmmFiles);
    add("DM types", s.types);
    add("Global vars", s.globals);
    add("Procs emitted", s.procs);
    add("Prototype YAML", s.prototypeFiles);
    add("C# files", s.csFiles);
    add("RSI packs", s.rsiDirs);
    add("Maps", s.mapFiles);
    add("Unresolved calls", s.unresolvedCalls, s.unresolvedCalls > 0 ? "warn" : "good");
    add("Parse warnings", s.warnings, s.warnings > 0 ? "warn" : "good");
    add("Parse errors", s.errors, s.errors > 0 ? "bad" : "good");
    add("Wall time", s.wallSeconds !== undefined ? s.wallSeconds + "s" : undefined);
    add("Output size", s.outputBytes !== undefined ? fmtBytes(s.outputBytes) : undefined);
    summaryNote.textContent = s.timings ? "Stage timings \u2014 " + s.timings : "";
    summaryCard.className = "card visible";
  }

  // Applies a finished run's result to the UI, once. Called by the convert
  // fetch response and by the SSE 'done' event — whichever lands first wins,
  // so a page that joined mid-run renders the same end state.
  function finishRunUI(data) {
    if (doneHandled) return;
    doneHandled = true;
    if (data.success) {
      progressFill.style.width = "100%";
      progressStage.textContent = "Done";
      log("");
      log("[SUCCESS] Transpilation complete! Output saved.");
      renderSummary(data.summary);
      successCard.className = "success-card visible";
      successPath.textContent = data.outputDir;
      browseRoot.value = data.outputDir;
      browserCard.className = "card visible";
      loadTree("");
    } else if (data.cancelled) {
      log("");
      log("[CANCELLED] Conversion cancelled by user.", "l-err");
      progressStage.textContent = "Cancelled";
    } else {
      log("");
      log("[ERROR] " + (data.error || "Failed"), "l-err");
      progressStage.textContent = "Failed";
    }
    // Hold the busy state a beat: a Cancel click that lands just after the
    // run ends would otherwise hit the re-enabled Convert button and start
    // an unintended run.
    setTimeout(function() { setBusy(false); }, 700);
  }

  convertBtn.addEventListener("click", async function() {
    if (!selectedFile || converting) return;
    doneHandled = false;
    setBusy(true);
    logBox.style.display = "block";
    logBox.innerHTML = "";
    successCard.className = "success-card";
    summaryCard.className = "card";
    progressFill.style.width = "0%";
    progressStage.textContent = "Uploading archive\u2026";

    var formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("outputPath", outputPath.value);
    formData.append("jobs", jobsSelect.value);

    try {
      var res = await fetch("/api/convert", { method: "POST", headers: { "X-Auth-Token": AUTH_TOKEN }, body: formData });
      var data = await res.json();
      finishRunUI(data);
    } catch (err) {
      finishRunUI({ success: false, error: err.message });
    }
  });

  cancelBtn.addEventListener("click", async function() {
    if (!converting) return;
    try {
      var res = await fetch("/api/cancel", { method: "POST", headers: { "X-Auth-Token": AUTH_TOKEN } });
      var data = await res.json();
      if (data.cancelled) log("[UI] Cancel requested \u2014 waiting for the worker to stop\u2026", "l-dim");
      else log("[UI] " + (data.error || "Nothing to cancel."), "l-dim");
    } catch (err) {
      log("[UI] Cancel failed: " + err.message, "l-err");
    }
  });

  // ---- Output browser ----
  function encPath(p) { return encodeURIComponent(p); }
  function apiGet(path, params) {
    var q = "?token=" + encodeURIComponent(AUTH_TOKEN) + "&" + params;
    return fetch(path + q).then(function(r) { return r.json(); });
  }

  browseBtn.addEventListener("click", function() { loadTree(""); });
  browseRoot.addEventListener("keydown", function(e) { if (e.key === "Enter") loadTree(""); });

  function renderBreadcrumb(root, rel) {
    breadcrumb.innerHTML = "";
    var parts = rel ? rel.split("/") : [];
    var mk = function(label, target, last) {
      var a = document.createElement("a");
      a.textContent = label;
      a.addEventListener("click", function() { loadTree(target); });
      breadcrumb.appendChild(a);
      if (!last) breadcrumb.appendChild(document.createTextNode(" / "));
    };
    mk(root.replace(/\\/+$/, "").split("/").pop() || root, "", parts.length === 0);
    for (var i = 0; i < parts.length; i++) {
      mk(parts[i], parts.slice(0, i + 1).join("/"), i === parts.length - 1);
    }
  }

  function loadTree(rel) {
    var root = browseRoot.value.trim();
    if (!root) return;
    browserCard.className = "card visible";
    fileViewer.className = "file-viewer";
    apiGet("/api/tree", "root=" + encPath(root) + "&path=" + encPath(rel)).then(function(data) {
      if (data.error) {
        treeList.innerHTML = '<div class="tree-empty">' + esc(data.error) + "</div>";
        breadcrumb.textContent = "";
        return;
      }
      browseRel = data.path || "";
      renderBreadcrumb(data.root, browseRel);
      treeList.innerHTML = "";
      var rows = [];
      if (browseRel !== "") {
        rows.push({ name: "..", dir: true, up: true });
      }
      (data.entries || []).forEach(function(en) { rows.push(en); });
      if (rows.length === 0) {
        treeList.innerHTML = '<div class="tree-empty">(empty directory)</div>';
      }
      rows.forEach(function(en) {
        var row = document.createElement("div");
        row.className = "tree-row";
        var name = document.createElement("span");
        name.className = "t-name" + (en.dir ? " is-dir" : "");
        name.textContent = (en.up ? "\u21A9 " : en.dir ? "\uD83D\uDCC1 " : "\uD83D\uDCC4 ") + en.name;
        var size = document.createElement("span");
        size.className = "t-size";
        size.textContent = en.dir ? "" : fmtBytes(en.size);
        row.appendChild(name); row.appendChild(size);
        row.addEventListener("click", function() {
          if (en.up) { loadTree(browseRel.split("/").slice(0, -1).join("/")); }
          else if (en.dir) { loadTree(browseRel ? browseRel + "/" + en.name : en.name); }
          else { loadFile(browseRel ? browseRel + "/" + en.name : en.name); }
        });
        treeList.appendChild(row);
      });
      if (data.truncated) {
        var note = document.createElement("div");
        note.className = "tree-empty";
        note.textContent = "(listing truncated \u2014 too many entries)";
        treeList.appendChild(note);
      }
    }).catch(function(err) {
      treeList.innerHTML = '<div class="tree-empty">' + esc(err.message) + "</div>";
    });
  }

  function loadFile(rel) {
    var root = browseRoot.value.trim();
    apiGet("/api/file", "root=" + encPath(root) + "&path=" + encPath(rel)).then(function(data) {
      if (data.error) {
        fileViewer.className = "file-viewer visible";
        fileName.textContent = rel;
        fileSize.textContent = "";
        fileText.textContent = data.error;
        return;
      }
      fileViewer.className = "file-viewer visible";
      fileName.textContent = data.path;
      fileSize.textContent = fmtBytes(data.size) + (data.truncated ? " (showing first 256 KB)" : "");
      fileText.textContent = data.binary ? "(binary file \u2014 preview not supported)" : data.text;
      fileText.scrollTop = 0;
    }).catch(function(err) {
      fileViewer.className = "file-viewer visible";
      fileName.textContent = rel;
      fileText.textContent = err.message;
    });
  }

  // One EventSource for the page's lifetime: on connect the server replays
  // the buffered log (and 'done' if the last run finished, or 'running' when
  // a convert is in flight), so reloads resume instead of going blank.
  openEvents();
})();
</script>
</body>
</html>`;
}
