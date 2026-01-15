/* ================= 1. CORE DATA & STATE ================= */
let chats = JSON.parse(localStorage.getItem('turbo_pro_chats')) || {};
let currentChatId = localStorage.getItem('turbo_pro_id');
let currentBase64File = null;
let currentFileType = null;

// Auto-init
if (!currentChatId || !chats[currentChatId]) createNewChat(true);
else { renderHistory(); loadChatUI(); }

/* Store functions */
function saveStore() {
  localStorage.setItem('turbo_pro_chats', JSON.stringify(chats));
  localStorage.setItem('turbo_pro_id', currentChatId);
  renderHistory();
}

function createNewChat(silent = false) {
  const id = 'chat_' + Date.now();
  chats[id] = { 
    title: 'Новый чат', 
    messages: [], 
    memory: "", 
    timestamp: Date.now() 
  };
  currentChatId = id;
  saveStore();
  if(!silent) { loadChatUI(); if(window.innerWidth < 768) toggleSidebar(); }
}

function switchChat(id) { currentChatId = id; saveStore(); loadChatUI(); if(window.innerWidth < 768) toggleSidebar(); }

function deleteChat(e, id) {
  e.stopPropagation();
  if(!confirm('Удалить чат?')) return;
  delete chats[id];
  if(id === currentChatId) {
    const keys = Object.keys(chats);
    if(keys.length) currentChatId = keys[0]; else createNewChat(true);
  }
  saveStore(); loadChatUI();
}

/* ================= 2. MESSAGE PARSING (MARKDOWN) ================= */
function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function copyCode(btn) {
  const code = btn.parentElement.nextElementSibling.innerText;
  navigator.clipboard.writeText(code);
  const original = btn.innerText; btn.innerText = "OK"; setTimeout(()=>btn.innerText=original, 1000);
}

function format(text) {
  let s = esc(text);

  // 1. Code Blocks
  s = s.replace(/```(\w+)?\s*\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><div class="code-header"><span>${lang || 'text'}</span><button onclick="copyCode(this)" style="background:none;border:none;color:#aaa;cursor:pointer;">Copy</button></div><code>${code.trim()}</code></pre>`;
  });

  // 2. Tables
  const tableRegex = /((?:\|.+\|(?:\n|\r))+)/g;
  s = s.replace(tableRegex, (match) => {
    const rows = match.trim().split('\n').filter(r => !r.includes('---'));
    let html = '<table>';
    rows.forEach((row, i) => {
      const cols = row.split('|').filter(c => c.trim() !== '');
      const tag = i === 0 ? 'th' : 'td';
      html += '<tr>' + cols.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    return html + '</table>';
  });

  // 3. Inline Styles
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[color:([\w#]+)\]([\s\S]*?)\[\/color\]/g, '<span style="color:$1">$2</span>');
  s = s.replace(/~~([\s\S]*?)~~/g, "<s>$1</s>");
  s = s.replace(/__([\s\S]*?)__/g, "<u>$1</u>");
  s = s.replace(/\*\*([\s\S]*?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([\s\S]*?)\*/g, "<em>$1</em>");
  s = s.replace(/\n/g, "<br>");
  
  return s;
}

/* ================= 3. LOGIC: MEMORY & VISION ================= */
async function runCompression(chatId) {
  const chat = chats[chatId];
  if(chat.messages.length <= 8) return; 

  const keep = 4; 
  const toCompress = chat.messages.slice(0, chat.messages.length - keep);
  const conversation = toCompress.map(m => `${m.role}: ${m.content}`).join("\n");

  const prompt = `
  Analyze this conversation part.
  CURRENT MEMORY: "${chat.memory}"
  NEW PART: "${conversation}"
  TASK: Merge them into one concise summary. Keep user goals, facts, tech stack.
  Output ONLY the summary.
  `;

  try {
    const API_KEY = localStorage.getItem("or_key");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer "+API_KEY },
      body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [{role:"system", content: prompt}] })
    });
    const data = await res.json();
    const newMem = data.choices[0].message.content;

    chats[chatId].memory = newMem;
    chats[chatId].messages = chat.messages.slice(-keep); 
    saveStore();
    console.log("Memory compressed:", newMem);
  } catch(e) { console.error("Compression failed", e); }
}

async function analyzeImage(base64) {
  const API_KEY = localStorage.getItem("or_key");
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer "+API_KEY },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini", 
        messages: [{
          role: "user", 
          content: [
            { type: "text", text: "Describe this image in detail. If code, write it out." },
            { type: "image_url", image_url: { url: base64 } }
          ]
        }]
      })
    });
    const data = await res.json();
    return data.choices[0].message.content;
  } catch(e) { return "[Error analyzing image]"; }
}

/* ================= 4. MAIN SEND FUNCTION ================= */
async function submitForm() {
  const txtField = document.getElementById("text");
  const txt = txtField.value.trim();
  if(!txt && !currentBase64File) return;
  
  const API_KEY = localStorage.getItem("or_key");
  if(!API_KEY) { openSettings(); return; }

  // UI Updates
  txtField.value = "";
  txtField.style.height = "auto";
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = true;
  
  // Add temp user msg (it will be redrawn by loadChatUI later)
  addMsg(txt || "(Attachment)", "me", null);
  showLoading();

  // 1. Handle File
  let contentToSend = txt;
  if (currentBase64File) {
    if (currentFileType.startsWith('image/')) {
      const desc = await analyzeImage(currentBase64File);
      contentToSend += `\n\n[USER ATTACHED IMAGE. DESCRIPTION: ${desc}]`;
    } else {
      contentToSend += `\n\n[ATTACHED FILE]:\n${currentBase64File}`;
    }
    clearFile();
  }

  // 2. Save User Msg
  const chat = chats[currentChatId];
  chat.messages.push({ role: "user", content: contentToSend });
  if(chat.messages.length === 1) chat.title = contentToSend.substring(0, 30);
  saveStore();

  // 3. Prepare System Prompt
  const isEco = document.getElementById("ecoMode").checked;
  const isSearch = document.getElementById("searchMode").checked;
  let userModel = localStorage.getItem("or_model") || "deepseek/deepseek-chat";
  let systemContent = localStorage.getItem("or_system") || "You are a helpful assistant.";
  
  const fullSystemMsg = `
[SYSTEM]
${systemContent}
[MEMORY]
${chat.memory}
[MODES]
${isEco ? "ECONOMY: Be concise." : ""}
${isSearch ? "SEARCH: Use web browsing logic or provide citations." : ""}
  `;

  // 4. API Call
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY,
        "HTTP-Referer": location.origin,
        "X-Title": "TurboAI Pro"
      },
      body: JSON.stringify({
        model: userModel,
        messages: [
          { role: "system", content: fullSystemMsg },
          ...chat.messages 
        ]
      })
    });
    
    const data = await res.json();
    if(data.error) throw new Error(data.error.message);
    const reply = data.choices[0].message.content;
    
    hideLoading();
    
    // Save Assistant Msg
    chat.messages.push({ role: "assistant", content: reply });
    saveStore();

    // Redraw entire chat with new messages (and indices for editing)
    loadChatUI();
    runCompression(currentChatId);

  } catch(e) {
    hideLoading();
    addMsg("❌ Error: " + e.message, "sys");
  } finally {
    sendBtn.disabled = false;
    txtField.focus();
  }
}

/* ================= 5. UI HELPERS (UPDATED) ================= */
function addMsg(text, type, index = null) {
  const chatBox = document.getElementById("chat");
  const d = document.createElement("div");
  d.className = "msg " + type;
  
  let contentHtml = format(text);

  // Add Action Buttons if this is a stored message
  if (index !== null) {
    const actionsHtml = `
      <div class="msg-actions">
        <button class="act-btn" onclick="editMsg(${index})" title="Редактировать">✎</button>
        <button class="act-btn del" onclick="deleteMsg(${index})" title="Удалить">✕</button>
      </div>`;
    contentHtml += actionsHtml;
  }

  d.innerHTML = contentHtml;

  d.innerHTML = contentHtml;
  chatBox.appendChild(d);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function showLoading() {
  const d = document.createElement("div"); d.id="loader"; d.className="msg bot";
  d.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  document.getElementById("chat").appendChild(d);
}
function hideLoading() { const l = document.getElementById("loader"); if(l) l.remove(); }
  
function loadChatUI() {
  const chatBox = document.getElementById("chat");
  chatBox.innerHTML = "";
  const chat = chats[currentChatId];
  
  if(chat.memory) {
    const memDiv = document.createElement("div"); memDiv.className="sys";
    memDiv.innerText = "⚡ Memory Active (History Compressed)";
    chatBox.appendChild(memDiv);
  }
  
  chat.messages.forEach((m, index) => {
    let displayContent = m.content;
    if(m.role === 'user' && m.content.includes("[USER ATTACHED IMAGE")) {
      displayContent = displayContent.split("[USER ATTACHED IMAGE")[0] + " <i>(Image Attached)</i>";
    }
    // PASS INDEX HERE
    addMsg(displayContent, m.role==='user'?'me':'bot', index);
  });
}

function renderHistory() {
  const list = document.getElementById("historyList");
  list.innerHTML = "";
  Object.keys(chats).sort((a,b)=>chats[b].timestamp-chats[a].timestamp).forEach(id => {
    const el = document.createElement("div");
    el.className = `chat-item ${id===currentChatId?'active':''}`;
    el.innerHTML = `<span class="chat-title" onclick="switchChat('${id}')">${chats[id].title}</span> <button class="del-btn" onclick="deleteChat(event, '${id}')">✕</button>`;
    list.appendChild(el);
  });
}

/* ================= 6. EDIT & DELETE LOGIC ================= */
function deleteMsg(index) {
  if(!confirm("Удалить это сообщение?")) return;
  chats[currentChatId].messages.splice(index, 1);
  saveStore();
  loadChatUI();
}

function editMsg(index) {
  const chatBox = document.getElementById("chat");
  const hasMem = !!chats[currentChatId].memory;
  const domIndex = hasMem ? index + 1 : index; 
  const msgDiv = chatBox.children[domIndex];
  
  if(!msgDiv) return;

  const rawText = chats[currentChatId].messages[index].content;
  
  msgDiv.innerHTML = `
  <textarea id="edit-area-${index}" class="edit-textarea">${rawText}</textarea>
    <div style="margin-top:5px; text-align:right;">
        <button onclick="saveEdit(${index})" style="background:var(--accent); color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; margin-right:5px;">Сохранить</button>
        <button onclick="loadChatUI()" style="background:#333; color:#ccc; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">Отмена</button>
    </div>
  `;
}

function saveEdit(index) {
  const txt = document.getElementById(`edit-area-${index}`).value;
  chats[currentChatId].messages[index].content = txt;
  saveStore();
  loadChatUI();
}

/* ================= 7. CUSTOM MODELS LOGIC ================= */
function loadCustomModels() {
  const custom = JSON.parse(localStorage.getItem('turbo_custom_models')) || [];
  const select = document.getElementById("setModel");
  
  // Clean old custom opts
  const existingCustoms = select.querySelectorAll('.custom-opt');
  existingCustoms.forEach(el => el.remove());

  custom.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.innerText = "★ " + m.name; 
    opt.className = "custom-opt";
    select.appendChild(opt);
  });
}

function addCustomModel() {
  const idInput = document.getElementById("newModelId");
  const nameInput = document.getElementById("newModelName");
  const id = idInput.value.trim();
  const name = nameInput.value.trim();

  if(!id || !name) return alert("Заполните оба поля!");

  const custom = JSON.parse(localStorage.getItem('turbo_custom_models')) || [];
  custom.push({ id, name });
  localStorage.setItem('turbo_custom_models', JSON.stringify(custom));

  idInput.value = "";
  nameInput.value = "";
  
  loadCustomModels();
  document.getElementById("setModel").value = id;
  alert(`Модель "${name}" добавлена!`);
}

/* File UI */
document.getElementById('fileInput').onchange = function(e) {
  const f = e.target.files[0];
  if(!f) return;
  const r = new FileReader();
  r.onload = (ev) => {
    currentBase64File = ev.target.result;
    currentFileType = f.type;
    document.getElementById('previewContainer').style.display = 'block';
    document.getElementById('fileName').innerText = "📎 " + f.name;
  };
  if(f.type.startsWith('image/')) r.readAsDataURL(f); else r.readAsText(f);
}
function clearFile() {
  currentBase64File=null; currentFileType=null;
  document.getElementById('fileInput').value="";
  document.getElementById('previewContainer').style.display="none";
}

/* Textarea Auto-resize */
const tx = document.getElementById("text");
tx.addEventListener("input", function(){ this.style.height='auto'; this.style.height=(this.scrollHeight)+'px'; });
tx.addEventListener("keydown", function(e){ if(e.ctrlKey && e.key === 'Enter') submitForm(); });

/* Settings */
function openSettings() { 
  document.getElementById("settings").classList.add("open"); 
  loadCustomModels(); // Load custom models on open
  document.getElementById("setKey").value = localStorage.getItem("or_key")||""; 
  document.getElementById("setModel").value = localStorage.getItem("or_model")||"deepseek/deepseek-chat"; 
}
function closeSettings() { document.getElementById("settings").classList.remove("open"); }
function saveSettings() {
  localStorage.setItem("or_key", document.getElementById("setKey").value.trim());
  localStorage.setItem("or_model", document.getElementById("setModel").value);
  localStorage.setItem("or_system", document.getElementById("setSystem").value);
  closeSettings();
}
function checkMemory() { alert("Сжатый контекст чата:\n\n" + (chats[currentChatId].memory || "Пусто")); }
function toggleSidebar() { document.getElementById("sidebar").classList.toggle("open"); }

// First Run
if(!localStorage.getItem("or_key")) setTimeout(openSettings, 500);

/* === Swipe to open sidebar (ChatGPT style) === */
let touchStartX = 0;
let touchEndX = 0;

document.addEventListener("touchstart", e => {
  touchStartX = e.changedTouches[0].screenX;
});

document.addEventListener("touchend", e => {
  touchEndX = e.changedTouches[0].screenX;
  handleSwipe();
});

function handleSwipe() {
  const sidebar = document.getElementById("sidebar");
  const diff = touchEndX - touchStartX;

  // Swipe right → open
  if (diff > 80 && !sidebar.classList.contains("open")) {
    sidebar.classList.add("open");
  }

  // Swipe left → close
  if (diff < -80 && sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
  }
}

/* === Click outside to close sidebar (ChatGPT style) === */
document.addEventListener("click", function(e) {
  const sidebar = document.getElementById("sidebar");
  const menuBtn = document.querySelector(".mobile-menu");

  // Если меню открыто
  if (sidebar.classList.contains("open")) {
    // Если клик НЕ по сайдбару и НЕ по кнопке ☰
    if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
      sidebar.classList.remove("open");
    }
  }
});

/* ================= 8. HTML/CSS/JS Editor ================= */
// Variables for editor state
let editorInitialized = false;
let editorFiles = [];
let activeFileId = null;
let originalConsoleLog = null;
let untitledCounter = 1;
// Tracks whether a preview pane has been created
let previewCreated = false;

// Open the editor overlay
function openEditor() {
  const overlay = document.getElementById('editorOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  // Initialize on first open
  if (!editorInitialized) {
    initEditor();
    editorInitialized = true;
  }
  // Override console.log to capture output
  if (!originalConsoleLog) {
    originalConsoleLog = console.log;
    console.log = function(...args) {
      // invoke original
      originalConsoleLog.apply(console, args);
      // build string
      const msg = args.map(a => {
        try {
          return (typeof a === 'object' ? JSON.stringify(a) : String(a));
        } catch(err) { return String(a); }
      }).join(' ');
      const out = document.getElementById('consoleOutput');
      if (out) {
        out.textContent += msg + '\n';
        out.scrollTop = out.scrollHeight;
      }
    };
  }

  // Log an informational message when the editor is opened
  try {
    console.log('Editor opened');
  } catch(e) {}
}

// Close editor overlay and restore console.log
function closeEditor() {
  const overlay = document.getElementById('editorOverlay');
  if (overlay) overlay.classList.remove('open');
  if (originalConsoleLog) {
    console.log = originalConsoleLog;
    originalConsoleLog = null;
  }
}

// Initialize the editor UI and default files
function initEditor() {
  const tabs = document.getElementById('editorTabs');
  const panes = document.getElementById('editorPanes');
  if (!tabs || !panes) return;
  tabs.innerHTML = '';
  panes.innerHTML = '';
  editorFiles = [];
  activeFileId = null;
  previewCreated = false;
  // default files
  // Create default files with blank content
  addFile('index.html', '', 'html', false);
  addFile('style.css', '', 'css', false);
  addFile('script.js', '', 'js', false);
  // console
  addConsolePane();
  // toolbar events
  const newBtn = document.getElementById('btnNewFile');
  const uploadBtn = document.getElementById('btnUploadFile');
  const downloadBtn = document.getElementById('btnDownloadZip');
  const fileInput = document.getElementById('fileUploadInput');
  if (newBtn) newBtn.onclick = createNewFile;
  if (uploadBtn) uploadBtn.onclick = () => { if (fileInput) fileInput.click(); };
  if (downloadBtn) downloadBtn.onclick = downloadZip;
  // The file input's onchange is defined in HTML to avoid double binding. Do not reassign here.
}

// Add file: create tab, pane and a simple code editor with line numbers
function addFile(name, content, mode, extra) {
  const tabs = document.getElementById('editorTabs');
  const panes = document.getElementById('editorPanes');
  if (!tabs || !panes) return;
  const id = 'file_' + editorFiles.length;
  // create file object
  const file = { id, name, extra };
  editorFiles.push(file);
  // create tab button
  const tab = document.createElement('button');
  tab.className = 'tab-button';
  tab.dataset.id = id;
  // create span for filename
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  tab.appendChild(nameSpan);
  // add close button for deletion
  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = function(ev) {
    ev.stopPropagation();
    removeFile(id);
  };
  tab.appendChild(closeBtn);
  // clicking on tab selects the file
  tab.onclick = function() { selectFile(id); };
  // Insert the new file tab before preview/console to ensure they remain at the end
  const consoleTab = tabs.querySelector('[data-id="console"]');
  const previewTab = tabs.querySelector('[data-id="preview"]');
  let insertBeforeNode = null;
  if (consoleTab && previewTab) {
    // choose the one that appears first in DOM order
    insertBeforeNode = consoleTab.compareDocumentPosition(previewTab) & Node.DOCUMENT_POSITION_FOLLOWING ? consoleTab : previewTab;
  } else {
    insertBeforeNode = consoleTab || previewTab;
  }
  if (insertBeforeNode) {
    tabs.insertBefore(tab, insertBeforeNode);
  } else {
    tabs.appendChild(tab);
  }
  // create pane
  const pane = document.createElement('div');
  pane.className = 'editor-pane';
  pane.id = 'pane-' + id;
  panes.appendChild(pane);
  // build wrapper with line numbers and textarea
  const wrapper = document.createElement('div');
  wrapper.className = 'editor-wrapper';
  // line numbers area
  const lines = document.createElement('div');
  lines.className = 'line-numbers';
  lines.textContent = '1';
  wrapper.appendChild(lines);
  // textarea for code
  const textarea = document.createElement('textarea');
  textarea.className = 'code-area';
  textarea.spellcheck = false;
  textarea.wrap = 'off';
  textarea.value = content || '';
  wrapper.appendChild(textarea);
  pane.appendChild(wrapper);
  // function to update line numbers
  const updateLines = () => {
    // Determine number of lines; ensure at least one line
    let count = textarea.value.split('\n').length;
    if (count < 1) count = 1;
    // Clear existing line numbers and rebuild as separate divs
    lines.innerHTML = '';
    for (let i = 1; i <= count; i++) {
      const div = document.createElement('div');
      div.textContent = i;
      lines.appendChild(div);
    }
  };
  // initial lines
  updateLines();
  // handle input/scroll for line sync
  textarea.addEventListener('input', updateLines);
  textarea.addEventListener('scroll', () => {
    lines.scrollTop = textarea.scrollTop;
  });
  // store editor API for retrieval
  file.textarea = textarea;
  file.getValue = function() { return this.textarea.value; };
  file.setValue = function(val) { this.textarea.value = val; updateLines(); };
  // auto select if first file
  if (editorFiles.length === 1) selectFile(id);
}

// Add console tab and pane
function addConsolePane() {
  const tabs = document.getElementById('editorTabs');
  const panes = document.getElementById('editorPanes');
  if (!tabs || !panes) return;
  const id = 'console';
  const tab = document.createElement('button');
  tab.className = 'tab-button';
  tab.innerText = 'Console';
  tab.dataset.id = id;
  tab.onclick = function() { selectFile(id); };
  tabs.appendChild(tab);
  const pane = document.createElement('div');
  pane.className = 'editor-pane';
  pane.id = 'pane-' + id;
  const pre = document.createElement('pre');
  pre.id = 'consoleOutput';
  pre.style.margin = '0';
  pre.style.padding = '10px';
  pre.style.height = '100%';
  pre.style.overflowY = 'auto';
  pre.style.background = '#0d1117';
  pre.style.color = '#ddd';
  pre.style.fontFamily = "'JetBrains Mono', monospace";
  pre.style.fontSize = '14px';
  pane.appendChild(pre);
  panes.appendChild(pane);
}

// Switch active file or console
function selectFile(id) {
  const tabs = document.querySelectorAll('#editorTabs .tab-button');
  const panes = document.querySelectorAll('#editorPanes .editor-pane');
  tabs.forEach(btn => {
    if (btn.dataset.id === id) btn.classList.add('active');
    else btn.classList.remove('active');
  });
  panes.forEach(pane => {
    if (pane.id === 'pane-' + id) pane.style.display = 'block';
    else pane.style.display = 'none';
  });
  activeFileId = id;

  // For our simple textarea editors no special resize logic is needed
}

// Create new file via prompt
function createNewFile() {
  // (Optional) log can be added here for debugging
  // Ask user for a file name. If prompt is canceled or empty, assign a default untitled name.
  let name = null;
  try {
    name = prompt('Введите имя файла (с расширением):');
  } catch(e) {
    // ignore prompt errors
    name = null;
  }
  if (!name) {
    name = `untitled-${untitledCounter}.txt`;
    untitledCounter++;
  }
  // ensure unique name
  for (const f of editorFiles) {
    if (f.name === name) {
      // append counter to avoid duplicates
      name = name.replace(/(\.\w+)?$/, function(match){
        return `-${untitledCounter}` + match;
      });
      untitledCounter++;
      break;
    }
  }
  // Determine mode (unused for simple textarea but kept for compatibility)
  let mode = '';
  if (name.endsWith('.html') || name.endsWith('.htm')) mode = 'html';
  else if (name.endsWith('.css')) mode = 'css';
  else if (name.endsWith('.js')) mode = 'js';
  else if (name.endsWith('.json')) mode = 'json';
  addFile(name, '', mode, true);
}

// Handle file upload and update appropriate editors
function handleFileUpload(e) {
  const list = e.target.files;
  if (!list) return;
  for (const f of list) {
    const reader = new FileReader();
    reader.onload = function(ev) {
      const content = ev.target.result;
      const name = f.name;
      const lowerName = name.toLowerCase();
      // match default files case-insensitively
      let target = null;
      if (/\.html?$/i.test(name)) target = editorFiles.find(file => file.name && file.name.toLowerCase() === 'index.html');
      else if (/\.css$/i.test(name)) target = editorFiles.find(file => file.name && file.name.toLowerCase() === 'style.css');
      else if (/\.js$/i.test(name)) target = editorFiles.find(file => file.name && file.name.toLowerCase() === 'script.js');
      if (target && target.setValue) {
        target.setValue(content);
      } else {
        // Determine editor mode (unused for simple textarea but kept for compatibility)
        let mode = '';
        if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) mode = 'html';
        else if (lowerName.endsWith('.css')) mode = 'css';
        else if (lowerName.endsWith('.js')) mode = 'js';
        else if (lowerName.endsWith('.json')) mode = 'json';
        else if (lowerName.endsWith('.txt')) mode = 'txt';
        addFile(name, content, mode, true);
      }
    };
    reader.readAsText(f);
  }
  e.target.value = '';
}

// Download current files as a zip
function downloadZip() {
  const zip = new JSZip();
  editorFiles.forEach(f => {
    // skip console (which is not stored in editorFiles)
    if (!f.getValue) return;
    const content = f.getValue();
    zip.file(f.name, content);
  });
  zip.generateAsync({ type: 'blob' }).then(function(blob) {
    saveAs(blob, 'project.zip');
  });
}

// Show preview of the current project by combining HTML, CSS and JS
function showPreview() {
  const tabs = document.getElementById('editorTabs');
  const panes = document.getElementById('editorPanes');
  if (!tabs || !panes) return;
  // If preview pane hasn't been created yet, build it
  if (!previewCreated) {
    // create tab
    const tab = document.createElement('button');
    tab.className = 'tab-button';
    tab.dataset.id = 'preview';
    tab.textContent = 'Preview';
    tab.onclick = function() { selectFile('preview'); };
    // always append preview at the end
    tabs.appendChild(tab);
    // create pane with iframe
    const pane = document.createElement('div');
    pane.className = 'editor-pane';
    pane.id = 'pane-preview';
    const iframe = document.createElement('iframe');
    iframe.id = 'previewFrame';
    iframe.style.border = 'none';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    pane.appendChild(iframe);
    panes.appendChild(pane);
    previewCreated = true;
  }
  // Gather contents
  const htmlFile = editorFiles.find(f => f.name === 'index.html');
  const cssFile = editorFiles.find(f => f.name === 'style.css');
  const jsFile = editorFiles.find(f => f.name === 'script.js');
  const htmlContent = htmlFile && htmlFile.getValue ? htmlFile.getValue() : '';
  const cssContent = cssFile && cssFile.getValue ? cssFile.getValue() : '';
  const jsContent = jsFile && jsFile.getValue ? jsFile.getValue() : '';
  // Build combined document
  let combined;
  if (/\<html[\s\S]*\>/i.test(htmlContent)) {
    combined = htmlContent;
    // Insert CSS
    if (cssContent) {
      if (/<\/head>/i.test(combined)) {
        combined = combined.replace(/<\/head>/i, `<style>${cssContent}</style></head>`);
      } else {
        combined = combined.replace(/<html[^>]*>/i, `$&<head><style>${cssContent}</style></head>`);
      }
    }
    // Insert JS
    if (jsContent) {
      if (/<\/body>/i.test(combined)) {
        combined = combined.replace(/<\/body>/i, `<script>${jsContent}</script></body>`);
      } else {
        combined += `<script>${jsContent}</script>`;
      }
    }
  } else {
    combined = `<!DOCTYPE html><html><head><style>${cssContent}</style></head><body>${htmlContent}<script>${jsContent}</script></body></html>`;
  }
  // Set into iframe
  const frame = document.getElementById('previewFrame');
  if (frame) {
    frame.srcdoc = combined;
  }
  selectFile('preview');
}

// Remove a file from the editor
function removeFile(id) {
  // Ask user for confirmation before deletion
  // Determine file name for message
  const fileObj = editorFiles.find(f => f.id === id);
  const fileName = fileObj ? fileObj.name : id;
  if (!confirm(`Удалить файл "${fileName}"?`)) return;
  // Remove from array
  const idx = editorFiles.findIndex(f => f.id === id);
  if (idx >= 0) {
    editorFiles.splice(idx, 1);
  }
  // Remove tab and pane
  const tab = document.querySelector('#editorTabs .tab-button[data-id="' + id + '"]');
  if (tab) tab.remove();
  const pane = document.getElementById('pane-' + id);
  if (pane) pane.remove();
  // If the removed file was active, switch to another file or console/preview
  if (activeFileId === id) {
    // Prefer first remaining file
    if (editorFiles.length > 0) {
      selectFile(editorFiles[0].id);
    } else if (previewCreated) {
      selectFile('preview');
    } else {
      selectFile('console');
    }
  }
}