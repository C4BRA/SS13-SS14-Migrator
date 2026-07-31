import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { DM2SS14Transpiler } from '../index.js';

export class GUIServer {
  private port: number;

  constructor(port: number = 3456) {
    this.port = port;
  }

  public start(): void {
    const server = http.createServer(async (req, res) => {
      const url = req.url || '/';

      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getHTMLContent());
        return;
      }

      if (req.method === 'POST' && url === '/api/convert') {
        await this.handleConvertRequest(req, res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(this.port, () => {
      console.log(`\n==================================================`);
      console.log(`\u{1F680} dm2ss14 macOS Desktop App launched!`);
      console.log(`\u{1F449} Open http://localhost:${this.port} in your browser`);
      console.log(`==================================================\n`);
    });
  }

  private async handleConvertRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';

        let zipBuffer: Buffer | null = null;
        let outputDirPath = path.join(process.env.HOME || '/tmp', 'Downloads', 'SS14-Converted-Server');

        if (contentType.includes('multipart/form-data')) {
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          if (boundaryMatch) {
            const boundary = boundaryMatch[1] || boundaryMatch[2];
            const parts = this.parseMultipart(body, boundary);

            const filePart = parts.find(p => p.filename);
            const outputPart = parts.find(p => p.name === 'outputPath');

            if (filePart) zipBuffer = filePart.data;
            if (outputPart) outputDirPath = outputPart.data.toString('utf-8').trim() || outputDirPath;
          }
        }

        if (!zipBuffer) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No zip file provided.' }));
          return;
        }

        const tempInputDir = path.join(process.cwd(), 'temp_gui_input_' + Date.now());
        fs.mkdirSync(tempInputDir, { recursive: true });

        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tempInputDir, true);

        const transpiler = new DM2SS14Transpiler();
        await transpiler.transpile({
          inputDir: tempInputDir,
          outputDir: outputDirPath
        });

        if (fs.existsSync(tempInputDir)) {
          fs.rmSync(tempInputDir, { recursive: true, force: true });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          outputDir: outputDirPath,
          message: 'Transpilation completed successfully!'
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Transpilation failed.' }));
      }
    });
  }

  private parseMultipart(body: Buffer, boundary: string): { name?: string; filename?: string; data: Buffer }[] {
    const parts: { name?: string; filename?: string; data: Buffer }[] = [];
    const boundaryBuf = Buffer.from('--' + boundary);

    let start = body.indexOf(boundaryBuf) + boundaryBuf.length;

    while (start < body.length) {
      const nextBoundary = body.indexOf(boundaryBuf, start);
      if (nextBoundary === -1) break;

      const partBuffer = body.subarray(start, nextBoundary);
      const headerEnd = partBuffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = partBuffer.subarray(0, headerEnd).toString('utf-8');
        const data = partBuffer.subarray(headerEnd + 4, partBuffer.length - 2);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);

        parts.push({
          name: nameMatch ? nameMatch[1] : undefined,
          filename: filenameMatch ? filenameMatch[1] : undefined,
          data
        });
      }

      start = nextBoundary + boundaryBuf.length;
    }

    return parts;
  }

  private getHTMLContent(): string {
    const defaultOutputPath = path.join(process.env.HOME || '', 'Downloads', 'SS14-Converted-Server');
    const lines = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>dm2ss14 Desktop App</title>',
'<style>',
':root {',
'  --bg: #0d1117; --card-bg: #161b22; --border: #30363d;',
'  --accent: #58a6ff; --accent-glow: rgba(88,166,255,0.25);',
'  --success: #3fb950; --text: #c9d1d9; --text-heading: #f0f6fc;',
'}',
'* { box-sizing: border-box; margin: 0; padding: 0; }',
'body {',
'  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
'  background: var(--bg); color: var(--text);',
'  display: flex; justify-content: center; align-items: center;',
'  min-height: 100vh; padding: 20px;',
'}',
'.app-container {',
'  width: 100%; max-width: 680px; background: var(--card-bg);',
'  border: 1px solid var(--border); border-radius: 16px;',
'  box-shadow: 0 12px 40px rgba(0,0,0,0.6); overflow: hidden;',
'  display: flex; flex-direction: column;',
'}',
'.app-header {',
'  background: rgba(255,255,255,0.03); padding: 24px 32px;',
'  border-bottom: 1px solid var(--border);',
'  display: flex; align-items: center; justify-content: space-between;',
'}',
'.app-title h1 { font-size: 22px; font-weight: 700; color: var(--text-heading); letter-spacing: -0.5px; }',
'.app-title p { font-size: 13px; color: #8b949e; margin-top: 4px; }',
'.status-badge {',
'  display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--success);',
'  background: rgba(63,185,80,0.1); padding: 6px 12px; border-radius: 20px;',
'  border: 1px solid rgba(63,185,80,0.3);',
'}',
'.status-dot { width: 8px; height: 8px; background: var(--success); border-radius: 50%; box-shadow: 0 0 8px var(--success); }',
'.app-body { padding: 32px; display: flex; flex-direction: column; gap: 24px; }',
'.dropzone {',
'  border: 2px dashed #30363d; border-radius: 12px; padding: 40px 20px;',
'  text-align: center; background: rgba(0,0,0,0.2); cursor: pointer;',
'  transition: all 0.2s ease; display: flex; flex-direction: column;',
'  align-items: center; gap: 12px;',
'}',
'.dropzone:hover, .dropzone.dragover { border-color: var(--accent); background: var(--accent-glow); }',
'.dropzone * { pointer-events: none; }',
'.dropzone-icon { font-size: 40px; }',
'.dropzone-text { font-size: 15px; color: var(--text-heading); font-weight: 600; }',
'.dropzone-sub { font-size: 12px; color: #8b949e; }',
'.field-group { display: flex; flex-direction: column; gap: 8px; }',
'.field-label { font-size: 13px; font-weight: 600; color: var(--text-heading); }',
'.field-input {',
'  background: #0d1117; border: 1px solid var(--border); border-radius: 8px;',
'  padding: 12px 14px; color: #f0f6fc; font-size: 14px; width: 100%;',
'  outline: none; transition: border-color 0.2s;',
'}',
'.field-input:focus { border-color: var(--accent); }',
'.btn-convert {',
'  background: var(--accent); color: #0d1117; font-size: 15px; font-weight: 700;',
'  padding: 14px; border: none; border-radius: 8px; cursor: pointer;',
'  transition: all 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px;',
'}',
'.btn-convert:hover { opacity: 0.9; transform: translateY(-1px); box-shadow: 0 4px 16px var(--accent-glow); }',
'.btn-convert:disabled { background: #30363d; color: #8b949e; cursor: not-allowed; transform: none; box-shadow: none; }',
'.log-box {',
'  background: #090d11; border: 1px solid var(--border); border-radius: 8px; padding: 16px;',
'  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;',
'  font-size: 13px; color: #7ee787; height: 160px; overflow-y: auto; display: none;',
'  white-space: pre-wrap; word-break: break-word;',
'}',
'.success-card {',
'  background: rgba(63,185,80,0.1); border: 1px solid rgba(63,185,80,0.3);',
'  border-radius: 8px; padding: 16px; display: none; flex-direction: column; gap: 8px;',
'}',
'.success-title { font-size: 15px; font-weight: 700; color: var(--success); }',
'.success-cmd {',
'  background: #0d1117; padding: 10px; border-radius: 6px;',
'  font-family: monospace; font-size: 13px; color: #f0f6fc; border: 1px solid var(--border);',
'}',
'</style>',
'</head>',
'<body>',
'<div class="app-container">',
'  <div class="app-header">',
'    <div class="app-title">',
'      <h1>dm2ss14 Transpiler</h1>',
'      <p>Convert any SS13 repository .zip into a compilable SS14 server solution</p>',
'    </div>',
'    <div class="status-badge"><div class="status-dot"></div>Ready</div>',
'  </div>',
'  <div class="app-body">',
'    <input type="file" id="fileInput" accept=".zip" style="display:none">',
'    <div class="dropzone" id="dropzone">',
'      <div class="dropzone-icon">\uD83D\uDCE6</div>',
'      <div class="dropzone-text" id="dropzoneText">Drop your SS13 repository .zip file here</div>',
'      <div class="dropzone-sub">or click to browse from Finder</div>',
'    </div>',
'    <div class="field-group">',
'      <label class="field-label">Output Save Destination Path:</label>',
'      <input type="text" id="outputPath" class="field-input" value="' + defaultOutputPath + '">',
'    </div>',
'    <button class="btn-convert" id="convertBtn" disabled>Convert to SS14 Solution</button>',
'    <div class="log-box" id="logBox"></div>',
'    <div class="success-card" id="successCard">',
'      <div class="success-title">\uD83C\uDF89 Conversion Complete!</div>',
'      <div>Your converted SS14 C# Solution is ready at:</div>',
'      <div class="success-cmd" id="successPath"></div>',
'      <div>To launch the converted SS14 server:</div>',
'      <div class="success-cmd">dotnet run --project Content.Server</div>',
'    </div>',
'  </div>',
'</div>',
'<script>',
'(function() {',
'  var dropzone = document.getElementById("dropzone");',
'  var fileInput = document.getElementById("fileInput");',
'  var dropzoneText = document.getElementById("dropzoneText");',
'  var convertBtn = document.getElementById("convertBtn");',
'  var outputPath = document.getElementById("outputPath");',
'  var logBox = document.getElementById("logBox");',
'  var successCard = document.getElementById("successCard");',
'  var successPath = document.getElementById("successPath");',
'  var selectedFile = null;',
'  var dragCounter = 0;',
'',
'  dropzone.addEventListener("click", function(e) {',
'    e.preventDefault();',
'    e.stopPropagation();',
'    fileInput.click();',
'  });',
'',
'  fileInput.addEventListener("change", function(e) {',
'    if (e.target.files && e.target.files.length > 0) {',
'      selectedFile = e.target.files[0];',
'      showSelected();',
'    }',
'  });',
'',
'  dropzone.addEventListener("dragenter", function(e) {',
'    e.preventDefault();',
'    e.stopPropagation();',
'    dragCounter++;',
'    dropzone.classList.add("dragover");',
'  });',
'',
'  dropzone.addEventListener("dragover", function(e) {',
'    e.preventDefault();',
'    e.stopPropagation();',
'  });',
'',
'  dropzone.addEventListener("dragleave", function(e) {',
'    e.preventDefault();',
'    e.stopPropagation();',
'    dragCounter--;',
'    if (dragCounter <= 0) { dragCounter = 0; dropzone.classList.remove("dragover"); }',
'  });',
'',
'  dropzone.addEventListener("drop", function(e) {',
'    e.preventDefault();',
'    e.stopPropagation();',
'    dragCounter = 0;',
'    dropzone.classList.remove("dragover");',
'    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {',
'      selectedFile = e.dataTransfer.files[0];',
'      showSelected();',
'    }',
'  });',
'',
'  document.addEventListener("dragover", function(e) { e.preventDefault(); });',
'  document.addEventListener("drop", function(e) { e.preventDefault(); });',
'',
'  function showSelected() {',
'    if (selectedFile) {',
'      dropzoneText.textContent = "\\u2705 Selected: " + selectedFile.name;',
'      convertBtn.disabled = false;',
'    }',
'  }',
'',
'  convertBtn.addEventListener("click", async function() {',
'    if (!selectedFile) return;',
'    convertBtn.disabled = true;',
'    convertBtn.textContent = "Transpiling... Please wait";',
'    logBox.style.display = "block";',
'    successCard.style.display = "none";',
'    logBox.textContent = "";',
'',
'    function log(msg) { logBox.textContent += msg + "\\n"; logBox.scrollTop = logBox.scrollHeight; }',
'',
'    log("[1/5] Extracting SS13 .zip archive...");',
'',
'    var formData = new FormData();',
'    formData.append("file", selectedFile);',
'    formData.append("outputPath", outputPath.value);',
'',
'    try {',
'      log("[2/5] Parsing DM source code...");',
'      log("[3/5] Emitting SS14 YAML Prototypes & C# ECS Systems...");',
'      log("[4/5] Converting DMI icon assets to RSI...");',
'      log("[5/5] Building SS14 Grid maps & SS13.DM.Runtime...");',
'',
'      var res = await fetch("/api/convert", { method: "POST", body: formData });',
'      var data = await res.json();',
'',
'      if (data.success) {',
'        log("");',
'        log("[SUCCESS] Transpilation complete! Output saved.");',
'        successCard.style.display = "flex";',
'        successPath.textContent = data.outputDir;',
'      } else {',
'        log("");',
'        log("[ERROR] " + (data.error || "Failed"));',
'      }',
'    } catch (err) {',
'      log("");',
'      log("[ERROR] " + err.message);',
'    } finally {',
'      convertBtn.disabled = false;',
'      convertBtn.textContent = "Convert to SS14 Solution";',
'    }',
'  });',
'})();',
'</script>',
'</body>',
'</html>',
    ];
    return lines.join('\n');
  }
}
