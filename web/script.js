const COMFY_HOST = "127.0.0.1:8188";
let currentStroke = [];
const canvas = document.getElementById("canvas");
canvas.addEventListener('contextmenu', e => e.preventDefault());
const ctx = canvas.getContext("2d", { alpha: false });

// ========== Cached DOM References ==========
const DOM = {
    canvas: canvas,
    modeBtn: null,
    brushGroup: null,
    tileSizeGroup: null,
    brushSlider: null,
    brushSizeDisplay: null,
    featherInput: null,
    promptInput: null,
    toggleMaskBtn: null,
    sizeSelector: null,
    customSizeCheckbox: null,
    customWidth: null,
    customHeight: null,
    glowOverlay: null,
    
    // Initialize all cached references
    init() {
        this.modeBtn = document.getElementById("modeBtn");
        this.brushGroup = document.getElementById("brushGroup");
        this.tileSizeGroup = document.getElementById("tileSizeGroup");
        this.brushSlider = document.getElementById("brushSlider");
        this.brushSizeDisplay = document.getElementById("brushSizeDisplay");
        this.featherInput = document.getElementById("featherInput");
        this.promptInput = document.getElementById("promptInput");
        this.toggleMaskBtn = document.getElementById("toggleMaskBtn");
        this.sizeSelector = document.getElementById("sizeSelector");
        this.customSizeCheckbox = document.getElementById("customSizeCheckbox");
        this.customWidth = document.getElementById("customWidth");
        this.customHeight = document.getElementById("customHeight");
        this.glowOverlay = document.getElementById("glow-overlay");
    }
};

// ========== Utility Functions ==========
// Throttle function for performance
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Debounce function for resize
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Cache for last successful inference result
let lastInferenceResult = null;

// WebSocket connection
let ws = null;
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT_ATTEMPTS = 5;
let pendingInference = null; // Store {tx, ty} for current inference
let receivedProgressThisInference = false; // Track if we got progress messages


let historyStack = [];
let redoStack = [];
const MAX_HISTORY = 50;

/**
 * Capture a deep copy of the images array state.
 * Call this BEFORE any destructive action (paste, drop, erase).
 */
// Add this helper function to create a deep copy of the state
function saveUndoState() {
    // Deep copy images including their canvas data
    const stateSnapshot = images.map(imgObj => {
        // Create a copy of the canvas
        const canvasCopy = document.createElement('canvas');
        canvasCopy.width = imgObj.img.width || imgObj.w;
        canvasCopy.height = imgObj.img.height || imgObj.h;
        const ctx = canvasCopy.getContext('2d');
        ctx.drawImage(imgObj.img, 0, 0);
        
        return {
            img: canvasCopy,
            x: imgObj.x,
            y: imgObj.y,
            w: imgObj.w,
            h: imgObj.h
        };
    });
    
    console.log(`[Undo] Saved canvas state with ${stateSnapshot.length} images`);
    
    historyStack.push({
        type: 'canvas_snapshot',
        state: stateSnapshot
    });
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    // Clear redo stack when new action is performed
    redoStack = [];
}

// Save complete mask state for undo
function saveMaskState() {
    const maskSnapshot = new Map();
    maskChunks.forEach((chunk, key) => {
        // Use chunk's actual dimensions to ensure proper copy
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = chunk.width;
        tempCanvas.height = chunk.height;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(chunk, 0, 0);
        maskSnapshot.set(key, tempCanvas);
    });
    
    console.log(`[Undo] Saved mask state with ${maskSnapshot.size} chunks`);
    
    historyStack.push({
        type: 'mask_snapshot',
        maskState: maskSnapshot
    });
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    // Clear redo stack when new action is performed
    redoStack = [];
}

function performUndo() {
    if (historyStack.length === 0 || isInferencing) return;
    const lastAction = historyStack.pop();

    if (lastAction.type === 'canvas_snapshot') {
        // Deep copy current state to redo before changing
        const currentState = images.map(imgObj => {
            const canvasCopy = document.createElement('canvas');
            canvasCopy.width = imgObj.img.width || imgObj.w;
            canvasCopy.height = imgObj.img.height || imgObj.h;
            const ctx = canvasCopy.getContext('2d');
            ctx.drawImage(imgObj.img, 0, 0);
            return {
                img: canvasCopy,
                x: imgObj.x,
                y: imgObj.y,
                w: imgObj.w,
                h: imgObj.h
            };
        });
        
        redoStack.push({
            type: 'canvas_snapshot',
            state: currentState
        });
        if (redoStack.length > MAX_HISTORY) redoStack.shift();
        
        console.log(`[Undo] Restoring ${lastAction.state.length} images (was ${images.length})`);
        
        images = lastAction.state; // Restores the array from the deep copy
        consoleLog.log("Undo: Action reversed", "info");
    } else if (lastAction.type === 'mask_snapshot') {
        // Save current complete mask state to redo
        const currentMaskSnapshot = new Map();
        maskChunks.forEach((chunk, key) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = chunk.width;
            tempCanvas.height = chunk.height;
            const ctx = tempCanvas.getContext('2d');
            ctx.drawImage(chunk, 0, 0);
            currentMaskSnapshot.set(key, tempCanvas);
        });
        
        redoStack.push({
            type: 'mask_snapshot',
            maskState: currentMaskSnapshot
        });
        if (redoStack.length > MAX_HISTORY) redoStack.shift();
        
        console.log(`[Undo] Restoring mask state with ${lastAction.maskState.size} chunks (was ${maskChunks.size})`);
        
        // Restore complete mask state
        maskChunks.clear();
        lastAction.maskState.forEach((chunkCanvas, key) => {
            const newChunk = document.createElement("canvas");
            newChunk.width = chunkCanvas.width;
            newChunk.height = chunkCanvas.height;
            const ctx = newChunk.getContext('2d');
            ctx.drawImage(chunkCanvas, 0, 0);
            maskChunks.set(key, newChunk);
        });
        
        consoleLog.log("Undo: Mask stroke", "info");
    } else if (lastAction.type === 'mask_stroke') {
        // Legacy support for old mask_stroke type - convert to mask_snapshot behavior
        const currentMaskState = [];
        lastAction.stroke.forEach(item => {
            const chunk = maskChunks.get(item.key);
            if (chunk) {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = chunk.width;
                tempCanvas.height = chunk.height;
                tempCanvas.getContext('2d').drawImage(chunk, 0, 0);
                currentMaskState.push({ key: item.key, prevState: tempCanvas });
            }
        });
        
        if (currentMaskState.length > 0) {
            redoStack.push({
                type: 'mask_stroke',
                stroke: currentMaskState
            });
            if (redoStack.length > MAX_HISTORY) redoStack.shift();
        }
        
        // Restore previous state for each chunk
        lastAction.stroke.forEach(item => {
            const chunk = maskChunks.get(item.key);
            if (chunk) {
                const ctx = chunk.getContext('2d');
                ctx.clearRect(0, 0, chunk.width, chunk.height);
                ctx.drawImage(item.prevState, 0, 0);
            } else {
                const newChunk = document.createElement("canvas");
                newChunk.width = item.prevState.width;
                newChunk.height = item.prevState.height;
                const ctx = newChunk.getContext('2d');
                ctx.drawImage(item.prevState, 0, 0);
                maskChunks.set(item.key, newChunk);
            }
        });
        consoleLog.log("Undo: Mask stroke", "info");
    }
    redraw();
}

function performRedo() {
    if (redoStack.length === 0 || isInferencing) return;
    const nextAction = redoStack.pop();

    if (nextAction.type === 'canvas_snapshot') {
        // Deep copy current state back to undo
        const currentState = images.map(imgObj => {
            const canvasCopy = document.createElement('canvas');
            canvasCopy.width = imgObj.img.width || imgObj.w;
            canvasCopy.height = imgObj.img.height || imgObj.h;
            const ctx = canvasCopy.getContext('2d');
            ctx.drawImage(imgObj.img, 0, 0);
            return {
                img: canvasCopy,
                x: imgObj.x,
                y: imgObj.y,
                w: imgObj.w,
                h: imgObj.h
            };
        });
        
        historyStack.push({
            type: 'canvas_snapshot',
            state: currentState
        });
        if (historyStack.length > MAX_HISTORY) historyStack.shift();
        
        console.log(`[Redo] Restoring ${nextAction.state.length} images`);
        
        images = nextAction.state;
        consoleLog.log("Redo: Action restored", "info");
    } else if (nextAction.type === 'mask_snapshot') {
        // Save current complete mask state back to undo
        const currentMaskSnapshot = new Map();
        maskChunks.forEach((chunk, key) => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = chunk.width;
            tempCanvas.height = chunk.height;
            const ctx = tempCanvas.getContext('2d');
            ctx.drawImage(chunk, 0, 0);
            currentMaskSnapshot.set(key, tempCanvas);
        });
        
        historyStack.push({
            type: 'mask_snapshot',
            maskState: currentMaskSnapshot
        });
        if (historyStack.length > MAX_HISTORY) historyStack.shift();
        
        console.log(`[Redo] Restoring mask state with ${nextAction.maskState.size} chunks`);
        
        // Restore complete mask state
        maskChunks.clear();
        nextAction.maskState.forEach((chunkCanvas, key) => {
            const newChunk = document.createElement("canvas");
            newChunk.width = chunkCanvas.width;
            newChunk.height = chunkCanvas.height;
            const ctx = newChunk.getContext('2d');
            ctx.drawImage(chunkCanvas, 0, 0);
            maskChunks.set(key, newChunk);
        });
        
        consoleLog.log("Redo: Mask stroke", "info");
    } else if (nextAction.type === 'mask_stroke') {
        // Legacy support for old mask_stroke type
        const currentMaskState = [];
        nextAction.stroke.forEach(item => {
            const chunk = maskChunks.get(item.key);
            if (chunk) {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = chunk.width;
                tempCanvas.height = chunk.height;
                tempCanvas.getContext('2d').drawImage(chunk, 0, 0);
                currentMaskState.push({ key: item.key, prevState: tempCanvas });
            }
        });
        
        if (currentMaskState.length > 0) {
            historyStack.push({
                type: 'mask_stroke',
                stroke: currentMaskState
            });
            if (historyStack.length > MAX_HISTORY) historyStack.shift();
        }
        
        // Restore redo state for each chunk
        nextAction.stroke.forEach(item => {
            const chunk = maskChunks.get(item.key);
            if (chunk) {
                const ctx = chunk.getContext('2d');
                ctx.clearRect(0, 0, chunk.width, chunk.height);
                ctx.drawImage(item.prevState, 0, 0);
            } else {
                const newChunk = document.createElement("canvas");
                newChunk.width = item.prevState.width;
                newChunk.height = item.prevState.height;
                const ctx = newChunk.getContext('2d');
                ctx.drawImage(item.prevState, 0, 0);
                maskChunks.set(item.key, newChunk);
            }
        });
        consoleLog.log("Redo: Mask stroke", "info");
    }
    redraw();
}


// ---------- Console Logger ----------
const consoleLog = {
    container: null,
    init() {
        this.container = document.getElementById('console-logger');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'console-logger';
            document.body.appendChild(this.container);
        }

        // Apply container layout (no background here)
        Object.assign(this.container.style, {
            position: "fixed",
            bottom: "20px",
            right: "20px",
            zIndex: "10000",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            pointerEvents: "none",
            background: "transparent"
        });
    },
    log(msg, type = 'info') {
        if (!this.container) this.init();

        const entry = document.createElement('div');
        // NEW CLASS NAME TO AVOID CSS CONFLICTS
        entry.className = `canvas-status-message log-${type}`;

        // Styling the individual log message
        Object.assign(entry.style, {
            padding: "8px 12px",
            borderRadius: "6px",
            color: type === 'error' ? '#ff4444' : '#00d2ff', // Cyan text for info
            marginBottom: "5px",
            fontSize: "12px",
            fontWeight: "bold",
            // THE FIX: Set background to transparent
            backgroundColor: "transparent", 
            border: "none",
            boxShadow: "none",
            // Add shadow to text so it's readable over images
            textShadow: "1px 1px 2px rgba(0,0,0,0.8)",
            marginTop: '6px',
            backgroundColor: 'transparent',
            animation: 'fadeInOut 6s ease-in-out forwards'
        });

        entry.textContent = `> ${msg}`;
        this.container.appendChild(entry);

        // Auto-remove after 6 seconds
        setTimeout(() => entry.remove(), 6000);
    }
};

// ---------- Glow/Shine Flash Effect ----------
function triggerGlowFlash(worldX, worldY, width, height) {
    const overlay = document.getElementById('glow-overlay');
    if (!overlay) return;

    // Convert world coordinates to screen coordinates
    const screenPos = worldToScreen(worldX, worldY);
    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;

    // Position and size the overlay to match the inference tile
    Object.assign(overlay.style, {
        left: `${screenPos.x}px`,
        top: `${screenPos.y}px`,
        width: `${scaledWidth}px`,
        height: `${scaledHeight}px`
    });

    // Remove active class if it exists (to restart animation)
    overlay.classList.remove('active');
    
    // Force reflow to restart animation
    void overlay.offsetWidth;
    
    // Add active class to trigger animation
    overlay.classList.add('active');
    glowAnimationActive = true;
    
    // Remove class and flag after animation completes
    setTimeout(() => {
        overlay.classList.remove('active');
        glowAnimationActive = false;
        redraw(); // Redraw to show tile selector again
    }, 1800);
}

// ---------- Particle Effects ----------
function createParticles(worldX, worldY, count = 20) {
    const colors = ['#00d2ff', '#4ecdc4', '#45b7d1', '#85c1e2'];
    
    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        const screenPos = worldToScreen(worldX, worldY);
        
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        const distance = Math.random() * 100 + 50;
        const endX = screenPos.x + Math.cos(angle) * distance;
        const endY = screenPos.y + Math.sin(angle) * distance;
        
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = Math.random() * 6 + 4;
        const duration = Math.random() * 0.5 + 0.8;
        
        Object.assign(particle.style, {
            position: 'fixed',
            left: `${screenPos.x}px`,
            top: `${screenPos.y}px`,
            width: `${size}px`,
            height: `${size}px`,
            background: color,
            borderRadius: '50%',
            pointerEvents: 'none',
            zIndex: '10001',
            boxShadow: `0 0 ${size * 2}px ${color}`,
            transition: `all ${duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
            opacity: '1'
        });
        
        document.body.appendChild(particle);
        
        requestAnimationFrame(() => {
            Object.assign(particle.style, {
                left: `${endX}px`,
                top: `${endY}px`,
                opacity: '0',
                transform: 'scale(0)'
            });
        });
        
        setTimeout(() => particle.remove(), duration * 1000 + 100);
    }
}

// ---------- Image Fade-In Effect ----------
let fadeInImages = new Set();

function addImageWithFade(imgData) {
    fadeInImages.add(imgData);
    imgData.fadeAlpha = 0;
    imgData.fadeStartTime = Date.now();
}



const style = document.createElement('style');
style.textContent = `


.inference-status {
    position: absolute;
    bottom: 10px;
    left: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 4px;
    padding: 8px;
    text-align: center;
    font-size: 12px;
    font-weight: bold;
    color: #feca57;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    animation: pulse 2s ease-in-out infinite;
}

.inference-progress-container {
    position: absolute;
    bottom: 40px;
    left: 10px;
    right: 10px;
    height: 8px;
    background: rgba(0, 0, 0, 0.6);
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid rgba(255, 159, 67, 0.3);
}

.inference-progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #ff9f43, #feca57);
    width: 0%;
    transition: width 0.3s ease;
    box-shadow: 0 0 10px rgba(255, 159, 67, 0.5);
}

@keyframes pulse {
    0%, 100% { opacity: 0.8; }
    50% { opacity: 1; }
}

.progress-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 11px;
    font-weight: bold;
    color: white;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    pointer-events: none;
}



/* 1. THE INFERENCE TILE FRAME */
.inference-tile {
    position: fixed;
    border: 1px solid rgba(255, 159, 67, 0.2);
    background: rgba(255, 159, 67, 0.03);
    pointer-events: none;
    z-index: 1001;
    animation: orangePulse 2s infinite ease-in-out;
}

@keyframes orangePulse {
    0%, 100% {
        box-shadow: 0 0 4px rgba(255, 159, 67, 0.4), 0 0 12px rgba(255, 159, 67, 0.2);
        border-color: rgba(255, 159, 67, 0.3);
    }
    50% {
        box-shadow: 0 0 8px rgba(255, 159, 67, 0.8), 0 0 25px rgba(255, 159, 67, 0.4);
        border-color: rgba(255, 159, 67, 0.8);
    }
}

.inference-abort {
    position: absolute;
    top: 10px;
    right: 10px;
    background: #e74c3c;
    color: white;
    border: none;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: bold;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    transition: all 0.2s;
}

/* 2. FLOATING CONSOLE LOGS (No Background, No Bars) */
#console-log {
    position: fixed;
    bottom: 20px;
    left: 20px;
    z-index: 1000;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 4px; /* Tight gap between messages */
}

.log-entry {
    font-family: 'monospace';
    font-size: 14px;
    font-weight: bold;
    background: none !important;
    border: none !important;

    /* Handle long text without scrollbars */
    white-space: pre-wrap;   /* Wraps text to next line if too long */
    word-wrap: break-word;   /* Breaks long words if necessary */
    text-align: right;       /* Keeps text pinned to the right edge */
    width: 100%;             /* Ensures text uses the container width */

    text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0px 2px 4px rgba(0,0,0,0.8);
}

.log-info    { color: #4a9eff; }
.log-success { color: #2ecc71; }
.log-error   { color: #e74c3c; }
.log-warning { color: #f39c12; }

@keyframes fadeInOut {
    0%   { opacity: 0; transform: translateX(20px); }
    10%  { opacity: 1; transform: translateX(0); }
    85%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(-20px); }
}

/* Add this to your style.textContent */
#drag-preview {
    position: fixed;
    pointer-events: none; /* Crucial so it doesn't block the drop event */
    border: 3px dashed #ff9f43;
    background: rgba(255, 159, 67, 0.15);
    z-index: 10000;
    display: none;
    box-shadow: 0 0 20px rgba(0,0,0,0.5);
}
`;
document.head.appendChild(style);


// ---------- Configuration ----------
let TILE_WIDTH = 512;
let TILE_HEIGHT = 768;
const CHUNK_SIZE = 1024;
const GRID_SIZE = 32;

let maskVisible = true;
let maskOpacity = 0.3;
let brushSize = 200;
let featherSize = 20;
let mode = "paint";

// ---------- Infinite State ----------
let zoom = window.innerWidth / 4096;
let offsetX = window.innerWidth / 2;
let offsetY = window.innerHeight / 2;

let images = [];
let maskChunks = new Map();

let painting = false;
let erasing = false;
let panning = false;
let lastPos = null;
let mouseWorld = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };
let touchedChunks = new Set();
let isInferencing = false;
let currentPromptId = null;
let inferenceTimeout = null; // Safety timeout
let lastProgressTime = null; // Track when we last received progress
let tileErasing = false;
let lastErasedTile = null;
let glowAnimationActive = false; // Track if glow animation is playing
let brushHidden = false; // Hide brush during and after generation
let brushHideTimeout = null; // Timeout for showing brush again

// Image placement state
let placementMode = false;
let placementImage = null; // {img, width, height}

// Helper function to show brush after 2 second delay
function showBrushAfterDelay() {
    if (brushHideTimeout) clearTimeout(brushHideTimeout);
    brushHideTimeout = setTimeout(() => {
        brushHidden = false;
        redraw();
    }, 2000);
}

// Copy entire flattened canvas to clipboard with glow animation
async function copyToClipboard() {
    if (isInferencing) return;
    
    try {
        if (images.length === 0) {
            consoleLog.log("No images to copy", "warning");
            return;
        }
        
        // Calculate bounds of all images
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        images.forEach(img => {
            minX = Math.min(minX, img.x);
            minY = Math.min(minY, img.y);
            maxX = Math.max(maxX, img.x + img.w);
            maxY = Math.max(maxY, img.y + img.h);
        });
        
        const copyW = maxX - minX;
        const copyH = maxY - minY;
        
        // Create canvas with full image bounds
        const copyCanvas = document.createElement("canvas");
        copyCanvas.width = copyW;
        copyCanvas.height = copyH;
        const ctx = copyCanvas.getContext("2d");
        
        // Draw all images
        ctx.translate(-minX, -minY);
        images.forEach(img => ctx.drawImage(img.img, img.x, img.y, img.w, img.h));
        
        // Convert to blob and copy to clipboard
        copyCanvas.toBlob(async (blob) => {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]);
                
                // Trigger orange burning glow animation covering entire image
                triggerGlowFlash(minX, minY, copyW, copyH);
                consoleLog.log(`Copied entire canvas ${copyW}×${copyH}px to clipboard`, "success");
            } catch (err) {
                consoleLog.log(`Clipboard error: ${err.message}`, "error");
            }
        }, "image/png");
        
    } catch (err) {
        consoleLog.log(`Copy failed: ${err.message}`, "error");
    }
}

// Initialize WebSocket connection
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    
    try {
        ws = new WebSocket(`ws://${COMFY_HOST}/ws?clientId=${getClientId()}`);
        
        ws.onopen = () => {
            console.log("✅ WebSocket connected to ComfyUI");
            wsReconnectAttempts = 0;
        };
        
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleWebSocketMessage(msg);
        };
        
        ws.onerror = (error) => {
            console.error("❌ WebSocket error:", error);
        };
        
        ws.onclose = () => {
            console.log("🔌 WebSocket disconnected");
            if (wsReconnectAttempts < WS_MAX_RECONNECT_ATTEMPTS) {
                wsReconnectAttempts++;
                setTimeout(() => connectWebSocket(), 2000 * wsReconnectAttempts);
            }
        };
    } catch (error) {
        console.error("Failed to create WebSocket:", error);
    }
}

function getClientId() {
    let clientId = localStorage.getItem('comfy_client_id');
    if (!clientId) {
        clientId = 'infinity_canvas_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('comfy_client_id', clientId);
    }
    return clientId;
}

function handleWebSocketMessage(msg) {
    const { type, data } = msg;
    
    // Debug logging
    console.log(`[WS] Message type: ${type}`, data);
    
    if (type === 'executing') {
        // data.node is the currently executing node, or null when done
        console.log(`[WS] Executing - node: ${data.node}, prompt_id: ${data.prompt_id}, current: ${currentPromptId}`);
        
        // Check if this is our prompt OR if we have a pending inference and node is null
        const isOurPrompt = data.prompt_id === currentPromptId;
        const isCompletionSignal = data.node === null && pendingInference && isInferencing;
        
        if (isOurPrompt || isCompletionSignal) {
            if (data.node === null) {
                // Execution complete
                console.log(`[WS] Execution complete. receivedProgress=${receivedProgressThisInference}`);
                clearInferenceTimeout();

                // If we received progress messages, this was a real execution - fetch results
                if (receivedProgressThisInference) {
                    console.log("[WS] Real execution completed, fetching results...");
                    updateInferenceStatus("Finalizing...");
                    if (pendingInference) {
                        setTimeout(() => {
                            fetchExecutionResult(currentPromptId, pendingInference.tx, pendingInference.ty);
                        }, 300);
                    }
                } else {
                    // No progress = cached execution, use local cache
                    console.log("[WS] Cached execution (no progress), checking for cached result...");
                    if (lastInferenceResult && pendingInference) {
                        const hasLoadImageNode = lastInferenceResult.hasLoadImageNode !== undefined ? lastInferenceResult.hasLoadImageNode : true;
                        consoleLog.log("Workflow unchanged - using cached result", "info");
                        processInferenceResult(lastInferenceResult.imgInfo, pendingInference.tx, pendingInference.ty, hasLoadImageNode);
                    } else {
                        // No client-side cache available
                        consoleLog.log("No previous result available - change workflow first", "warning");
                        isInferencing = false;
                        currentPromptId = null;
                        pendingInference = null;
                        removeInferenceTile();
                        showBrushAfterDelay();
                        redraw();
                    }
                }
            }
        }
    } else if (type === 'progress') {
        if (data.prompt_id === currentPromptId) {
            receivedProgressThisInference = true; // Mark that we got progress
            lastProgressTime = Date.now();
            const percent = Math.round((data.value / data.max) * 100);
            updateInferenceStatus(`Generating... ${percent}%`, percent);
            
            // Reset safety timeout on each progress update
            resetInferenceTimeout();
            
            // If we hit 100%, start a fallback fetch after a short delay
            if (percent >= 100 && pendingInference) {
                console.log("[WS] Progress at 100%, starting fallback timer...");
                setTimeout(() => {
                    // Only fetch if we're still inferencing (not already handled by executed/executing)
                    if (isInferencing && pendingInference && currentPromptId) {
                        console.log("[WS] Fallback: fetching results after 100% progress");
                        updateInferenceStatus("Finalizing...", 100);
                        fetchExecutionResult(currentPromptId, pendingInference.tx, pendingInference.ty);
                    }
                }, 1500);
            }
        }
    } else if (type === 'executed') {
        // Node execution complete with output - THIS is the most reliable completion signal
        console.log(`[WS] Node executed with output:`, data);
        clearInferenceTimeout(); // Clear safety timeout
        if (data.prompt_id === currentPromptId && data.output?.images && data.output.images.length > 0) {
            // Images are ready - use them directly!
            console.log("[WS] Images ready in executed message, processing directly");
            const imgInfo = data.output.images[0];
            if (pendingInference) {
                const hasLoadImageNode = window.hasLoadImageNode !== undefined ? window.hasLoadImageNode : true;
                console.log(`[WS Executed] window.hasLoadImageNode=${window.hasLoadImageNode}, using hasLoadImageNode=${hasLoadImageNode}`);
                lastInferenceResult = { imgInfo, tx: pendingInference.tx, ty: pendingInference.ty, hasLoadImageNode };
                processInferenceResult(imgInfo, pendingInference.tx, pendingInference.ty, hasLoadImageNode);
            }
        }
    } else if (type === 'execution_error') {
        if (data.prompt_id === currentPromptId) {
            consoleLog.log(`Execution error: ${data.exception_message || 'Unknown error'}`, "error");
            isInferencing = false;
            currentPromptId = null;
            pendingInference = null;
            removeInferenceTile();
            showBrushAfterDelay();
            redraw();
        }
    } else if (type === 'execution_cached') {
        console.log("[WS] Execution cached - workflow unchanged");
        if (data.prompt_id === currentPromptId) {
            clearInferenceTimeout();
            
            console.log(`[WS Cached] lastInferenceResult exists: ${!!lastInferenceResult}, pendingInference exists: ${!!pendingInference}`);
            
            // Workflow unchanged - use cached result immediately if available
            if (lastInferenceResult && pendingInference) {
                const hasLoadImageNode = lastInferenceResult.hasLoadImageNode !== undefined ? lastInferenceResult.hasLoadImageNode : true;
                console.log(`[WS Cached] Using cached result with hasLoadImageNode=${hasLoadImageNode}`);
                consoleLog.log("Workflow unchanged - using cached result", "info");
                processInferenceResult(lastInferenceResult.imgInfo, pendingInference.tx, pendingInference.ty, hasLoadImageNode);
            } else {
                // No cached result available - notify user and cancel
                console.log(`[WS Cached] No cached result available`);
                consoleLog.log("No previous result available - change workflow first", "warning");
                isInferencing = false;
                currentPromptId = null;
                pendingInference = null;
                removeInferenceTile();
                showBrushAfterDelay();
                redraw();
            }
        }
    }
}

async function fetchExecutionResult(promptId, tx, ty, retryCount = 0) {
    const maxRetries = 5;
    
    console.log(`[Fetch] Attempting to fetch result for ${promptId}, retry ${retryCount}/${maxRetries}`);
    
    try {
        updateInferenceStatus("Loading...");
        
        const histRes = await fetch(`http://${COMFY_HOST}/history/${promptId}`);
        const histData = await histRes.json();
        
        console.log(`[Fetch] History data:`, histData);
        
        if (histData[promptId]) {
            const outputs = histData[promptId].outputs;
            const status = histData[promptId].status;
            
            console.log(`[Fetch] Status:`, status, `Outputs:`, outputs);
            
            if (outputs && Object.keys(outputs).length > 0) {
                let imgInfo = null;
                for (const nodeId in outputs) {
                    if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                        imgInfo = outputs[nodeId].images[0];
                        console.log(`[Fetch] Found image in node ${nodeId}:`, imgInfo);
                        break;
                    }
                }
                
                if (imgInfo) {
                    const hasLoadImageNode = window.hasLoadImageNode !== undefined ? window.hasLoadImageNode : true;
                    console.log(`[Fetch] window.hasLoadImageNode=${window.hasLoadImageNode}, using hasLoadImageNode=${hasLoadImageNode}`);
                    lastInferenceResult = { imgInfo, tx, ty, hasLoadImageNode };
                    processInferenceResult(imgInfo, tx, ty, hasLoadImageNode);
                    return;
                }
            }
            
            // No outputs yet - check if execution is complete (status.completed exists)
            if (status && status.completed === true) {
                // Execution completed but no output - workflow unchanged, use cache immediately
                console.log("[Fetch] Execution complete but no output - workflow likely cached/unchanged");
                if (lastInferenceResult) {
                    consoleLog.log("Workflow unchanged - using cached result", "info");
                    processInferenceResult(lastInferenceResult.imgInfo, tx, ty, lastInferenceResult.hasLoadImageNode);
                    return;
                } else {
                    // No cached result available
                    consoleLog.log("No previous result available - change workflow first", "warning");
                    isInferencing = false;
                    currentPromptId = null;
                    pendingInference = null;
                    removeInferenceTile();
                    showBrushAfterDelay();
                    redraw();
                    return;
                }
            }
            
            // No outputs yet, but history exists - retry if under limit
            if (retryCount < maxRetries) {
                console.log(`[Fetch] No outputs yet, retrying (${retryCount + 1}/${maxRetries})...`);
                setTimeout(() => {
                    fetchExecutionResult(promptId, tx, ty, retryCount + 1);
                }, 500);
                return;
            }
            
            // Max retries reached - use cached result if available
            console.log("[Fetch] Max retries reached, checking cache");
            if (lastInferenceResult) {
                consoleLog.log("No new output - using cached result", "warning");
                processInferenceResult(lastInferenceResult.imgInfo, tx, ty, lastInferenceResult.hasLoadImageNode);
            } else {
                consoleLog.log("No output generated", "error");
                isInferencing = false;
                currentPromptId = null;
                pendingInference = null;
                removeInferenceTile();
                showBrushAfterDelay();
                redraw();
            }
        } else {
            // No history data yet - retry if under limit
            if (retryCount < maxRetries) {
                console.log(`[Fetch] History not ready, retrying (${retryCount + 1}/${maxRetries})...`);
                setTimeout(() => {
                    fetchExecutionResult(promptId, tx, ty, retryCount + 1);
                }, 500);
                return;
            }
            
            // Max retries reached
            console.log("[Fetch] No history after max retries");
            if (lastInferenceResult) {
                consoleLog.log("History timeout - using cached result", "warning");
                processInferenceResult(lastInferenceResult.imgInfo, lastInferenceResult.tx, lastInferenceResult.ty, lastInferenceResult.hasLoadImageNode);
            } else {
                consoleLog.log("Failed to fetch results", "error");
                isInferencing = false;
                currentPromptId = null;
                pendingInference = null;
                removeInferenceTile();
                showBrushAfterDelay();
                redraw();
            }
        }
    } catch (error) {
        console.error("[Fetch] Error:", error);
        
        // Retry on error if under limit
        if (retryCount < maxRetries) {
            console.log(`[Fetch] Error, retrying (${retryCount + 1}/${maxRetries})...`);
            setTimeout(() => {
                fetchExecutionResult(promptId, tx, ty, retryCount + 1);
            }, 500);
            return;
        }
        
        // Max retries reached
        console.log("[Fetch] Max retries after error");
        if (lastInferenceResult) {
            consoleLog.log("Error fetching result - using cache", "warning");
            processInferenceResult(lastInferenceResult.imgInfo, lastInferenceResult.tx, lastInferenceResult.ty, lastInferenceResult.hasLoadImageNode);
        } else {
            consoleLog.log("Failed to fetch results", "error");
            isInferencing = false;
            currentPromptId = null;
            pendingInference = null;
            removeInferenceTile();
            showBrushAfterDelay();
            redraw();
        }
    }
}

const bufferCanvas = document.createElement("canvas");
const bufferCtx = bufferCanvas.getContext("2d");

const brushSlider = document.getElementById('brushSlider');
const brushContainer = document.getElementById('brushContainer');
const featherInput = document.getElementById('featherInput');

if (brushSlider) {
    brushSlider.oninput = function () {
        brushSize = parseInt(this.value);
        updateBrushSizeDisplay();
    };
}

// Global Ctrl+Wheel handler to change brush size instantly regardless of pointer location
window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();

    // Use fixed 25-integer steps per user request
    const step = 25;
    const delta = e.deltaY < 0 ? step : -step;

    brushSize = Math.max(10, Math.min(2000, Math.round(brushSize + delta)));
    if (brushSlider) brushSlider.value = brushSize;
    updateBrushSizeDisplay();
    redraw();
}, { passive: false });

// Update the live brush size display
function updateBrushSizeDisplay() {
    const display = document.getElementById('brushSizeDisplay');
    if (display) {
        display.textContent = brushSize;
    }
}
// Initialize display
updateBrushSizeDisplay();

if (featherInput) {
    featherInput.oninput = function () {
        featherSize = Math.max(0, parseInt(this.value) || 0);
    };
    // Ensure the UI shows the default feather value
    try {
        featherInput.value = featherSize;
        featherInput.dispatchEvent(new Event('input'));
    } catch (err) {
        console.warn('Failed to set default feather input:', err);
    }
}

// ---------- Setup & Resize ----------
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    bufferCanvas.width = window.innerWidth;
    bufferCanvas.height = window.innerHeight;
    redraw();
}
window.onresize = debounce(resize, 150);
resize();

// Initialize WebSocket connection
connectWebSocket();

function getChunk(cx, cy, createIfMissing = false) {
    const key = `${cx},${cy}`;
    if (maskChunks.has(key)) return maskChunks.get(key);
    if (createIfMissing) {
        const c = document.createElement("canvas");
        c.width = CHUNK_SIZE;
        c.height = CHUNK_SIZE;
        maskChunks.set(key, c);
        return c;
    }
    return null;
}

// ---------- Workflow Listener ----------
// Try to restore workflow from localStorage on load
try {
    const savedWorkflow = localStorage.getItem('infinity_canvas_workflow');
    if (savedWorkflow) {
        window.activeWorkflow = JSON.parse(savedWorkflow);
        consoleLog.log("Workflow restored from previous session", "success");
    }
} catch (err) {
    console.warn('Failed to restore workflow:', err);
}

window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SYNC_WORKFLOW") {
        window.activeWorkflow = event.data.workflow;
        
        // Save workflow to localStorage for persistence across refreshes
        try {
            localStorage.setItem('infinity_canvas_workflow', JSON.stringify(event.data.workflow));
        } catch (err) {
            console.warn('Failed to save workflow to localStorage:', err);
        }
        
        consoleLog.log("Workflow synced successfully", "success");

        if (window.pingTimer) {
            clearInterval(window.pingTimer);
            window.pingTimer = null;
        }
    }
});

window.pingTimer = setInterval(() => {
    if (window.activeWorkflow) {
        clearInterval(window.pingTimer);
        window.pingTimer = null;
    } else if (window.opener) {
        // Silent ping - no console log
        window.opener.postMessage("CANVAS_READY", "*");
    } else {
        clearInterval(window.pingTimer);
    }
}, 2000);

// ---------- Drag & Drop ----------
canvas.ondragover = e => e.preventDefault();


// ---------- Flattening ----------
function flattenImages() {
    if (images.length <= 1) return;

    consoleLog.log("Flattening images...", "info");

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    images.forEach(img => {
        minX = Math.min(minX, img.x);
        minY = Math.min(minY, img.y);
        maxX = Math.max(maxX, img.x + img.w);
        maxY = Math.max(maxY, img.y + img.h);
    });

    const flatCanvas = document.createElement("canvas");
    flatCanvas.width = maxX - minX;
    flatCanvas.height = maxY - minY;
    const flatCtx = flatCanvas.getContext("2d");

    images.forEach(img => {
        flatCtx.drawImage(img.img, img.x - minX, img.y - minY, img.w, img.h);
    });

    images = [{
        img: flatCanvas,
        x: minX,
        y: minY,
        w: flatCanvas.width,
        h: flatCanvas.height
    }];

    consoleLog.log("Images flattened", "success");
    redraw();
}

// ---------- Input Logic ----------
canvas.addEventListener("mousedown", e => {

    const { x, y } = screenToWorld(e.clientX, e.clientY);

    // Handle placement mode click
    if (placementMode && e.button === 0) {
        // Snap to grid - center the image on the grid
        const snapX = Math.round((x - placementImage.width / 2) / GRID_SIZE) * GRID_SIZE;
        const snapY = Math.round((y - placementImage.height / 2) / GRID_SIZE) * GRID_SIZE;
        
        // Place the image at snapped position
        saveUndoState();
        const newImg = {
            img: placementImage.img,
            x: snapX,
            y: snapY,
            w: placementImage.width,
            h: placementImage.height
        };
        images.push(newImg);
        addImageWithFade(newImg);
        
        // Trigger particle effect at placement location
        createParticles(snapX + placementImage.width / 2, snapY + placementImage.height / 2, 15);
        
        consoleLog.log(`Image placed: ${placementImage.width}x${placementImage.height}`, "success");
        placementMode = false;
        placementImage = null;
        canvas.style.cursor = mode === 'paint' ? 'crosshair' : 'default';
        flattenImages();
        redraw();
        return;
    }

    if (e.button === 1 || mode === 'pan') {
        panning = true;
        panStart = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = "grabbing";
        return;
    }

    if (isInferencing) return;

    if (mode === "paint") {
        if (e.button === 0) {
            painting = true;
            erasing = false;
            // Add painting class for visual feedback
            const brushGroup = document.getElementById("brushGroup");
            if (brushGroup) brushGroup.classList.add("painting");
        }
        if (e.button === 2) {
            e.preventDefault();
            erasing = true;
            painting = false;
            // Add erasing class for visual feedback
            const brushGroup = document.getElementById("brushGroup");
            if (brushGroup) brushGroup.classList.add("erasing");
        }
        
        // Save complete mask state before starting stroke
        saveMaskState();
        
        lastPos = { x, y };
        touchedChunks.clear();
        drawStroke(x, y);
    }

    if (mode === "tile") {
        const tx = Math.round((x - TILE_WIDTH / 2) / GRID_SIZE) * GRID_SIZE;
        const ty = Math.round((y - TILE_HEIGHT / 2) / GRID_SIZE) * GRID_SIZE;

        if (e.button === 0) {
            flattenImages();
            saveTileAsPNG(tx, ty);
        } else if (e.button === 2) {
            e.preventDefault();
            // Start continuous tile erasing while right button is held
            tileErasing = true;
            lastErasedTile = { tx, ty };
            // Save undo state once at start of continuous erase
            saveUndoState();
            deleteImagesAtTile(tx, ty, true, true); // Skip undo and log since we just saved
        }
    }
});

canvas.addEventListener("mousemove", e => {

    mouseWorld = screenToWorld(e.clientX, e.clientY);
    if (panning) {
        offsetX += e.clientX - panStart.x;
        offsetY += e.clientY - panStart.y;
        panStart = { x: e.clientX, y: e.clientY };
    } else if (painting || erasing) {
        drawStroke(mouseWorld.x, mouseWorld.y);
    } else if (tileErasing && mode === "tile") {
        // Continuous tile erasing while right mouse is held
        const tx = Math.round((mouseWorld.x - TILE_WIDTH / 2) / GRID_SIZE) * GRID_SIZE;
        const ty = Math.round((mouseWorld.y - TILE_HEIGHT / 2) / GRID_SIZE) * GRID_SIZE;
        if (!lastErasedTile || lastErasedTile.tx !== tx || lastErasedTile.ty !== ty) {
            lastErasedTile = { tx, ty };
            deleteImagesAtTile(tx, ty, true, true); // Skip undo and log - already saved at start
        }
    }
    // Always redraw if in placement mode to update preview position
    if (placementMode || panning || painting || erasing) {
        redraw();
    } else {
        redraw();
    }
});

// Removed global wheel handler for ctrl+scroll to avoid duplicate handling
// Brush-size via Ctrl+Scroll is handled on the canvas element for realtime updates.

window.addEventListener("mouseup", () => {
    if (painting || erasing) {
        // Clear stroke tracking but don't save to history (already saved on mousedown)
        currentStroke = [];
        touchedChunks.clear();
        
        // Remove painting/erasing classes
        const brushGroup = document.getElementById("brushGroup");
        if (brushGroup) {
            brushGroup.classList.remove("painting", "erasing");
        }
    }

    // Log tile erase only once on mouseup
    if (tileErasing) {
        consoleLog.log("Tile area erased", "info");
    }

    painting = false;
    erasing = false;
    panning = false;
    // Stop tile erasing on mouseup
    tileErasing = false;
    lastErasedTile = null;

    // Don't change cursor if in placement mode
    if (!placementMode) {
        if (mode === 'pan') {
            canvas.style.cursor = "grab";
        } else {
            canvas.style.cursor = "crosshair";
        }
    }
});

canvas.addEventListener("wheel", e => {
    // REMOVED: if (isInferencing) return;

    e.preventDefault();
    if (e.ctrlKey) {
        // Ctrl+wheel handled globally to keep behavior consistent; skip here
        e.preventDefault();
        return;
    } else {
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const mBefore = screenToWorld(e.clientX, e.clientY);
        zoom = clamp(zoom * zoomFactor, 0.05, 5);
        const mAfter = screenToWorld(e.clientX, e.clientY);
        offsetX += (mAfter.x - mBefore.x) * zoom;
        offsetY += (mAfter.y - mBefore.y) * zoom;
    }
    redraw();
}, { passive: false });



// ---------- Drawing ----------
function drawStroke(x, y) {
    if (!lastPos) return;
    const dx = x - lastPos.x, dy = y - lastPos.y;
    const dist = Math.hypot(dx, dy);

    const steps = Math.max(1, Math.ceil(dist / (brushSize / 4)));

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = lastPos.x + dx * t, py = lastPos.y + dy * t;
        const rad = brushSize / 2;

        const sCX = Math.floor((px - rad) / CHUNK_SIZE), eCX = Math.floor((px + rad) / CHUNK_SIZE);
        const sCY = Math.floor((py - rad) / CHUNK_SIZE), eCY = Math.floor((py + rad) / CHUNK_SIZE);

        for (let cy = sCY; cy <= eCY; cy++) {
            for (let cx = sCX; cx <= eCX; cx++) {
                const key = `${cx},${cy}`;
                const chunk = getChunk(cx, cy, true);

                if (!touchedChunks.has(key)) {
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = CHUNK_SIZE;
                    tempCanvas.height = CHUNK_SIZE;
                    tempCanvas.getContext('2d').drawImage(chunk, 0, 0);

                    currentStroke.push({ key: key, prevState: tempCanvas });
                    touchedChunks.add(key);
                }

                const cCtx = chunk.getContext("2d");
                cCtx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
                
                // Apply feathering using radial gradient
                if (featherSize > 0) {
                    const clampedFeather = Math.min(featherSize, rad); // Ensure feather doesn't exceed radius
                    const innerRadius = Math.max(0, rad - clampedFeather);
                    
                    const gradient = cCtx.createRadialGradient(
                        px - cx * CHUNK_SIZE, py - cy * CHUNK_SIZE, innerRadius,
                        px - cx * CHUNK_SIZE, py - cy * CHUNK_SIZE, rad
                    );
                    
                    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
                    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
                    cCtx.fillStyle = gradient;
                } else {
                    cCtx.fillStyle = "white";
                }
                
                cCtx.beginPath();
                cCtx.arc(px - cx * CHUNK_SIZE, py - cy * CHUNK_SIZE, rad, 0, Math.PI * 2);
                cCtx.fill();
            }
        }
    }
    lastPos = { x, y };
}

// ---------- Rendering ----------
function redraw() {
    // 1. Clear and Prepare Main Canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Clear Buffer Canvas
    bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    bufferCtx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);

    // 3. Apply Camera Transform (Zoom/Pan) to both contexts
    ctx.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);
    bufferCtx.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);

    // 4. Draw Background Grid
    const sC = Math.floor(-offsetX / zoom / GRID_SIZE), eC = sC + (canvas.width / zoom / GRID_SIZE) + 1;
    const sR = Math.floor(-offsetY / zoom / GRID_SIZE), eR = sR + (canvas.height / zoom / GRID_SIZE) + 1;
    for (let y = sR; y < eR; y++) {
        for (let x = sC; x < eC; x++) {
            ctx.fillStyle = ((x + y) % 2) ? "#333" : "#2a2a2a";
            ctx.fillRect(x * GRID_SIZE, y * GRID_SIZE, GRID_SIZE, GRID_SIZE);
        }
    }

    // 5. Draw All Images onto Buffer
    for (const img of images) {
        // Handle fade-in animation
        if (fadeInImages.has(img)) {
            const elapsed = Date.now() - img.fadeStartTime;
            const fadeInDuration = 800; // ms
            
            if (elapsed < fadeInDuration) {
                img.fadeAlpha = Math.min(1, elapsed / fadeInDuration);
                bufferCtx.save();
                bufferCtx.globalAlpha = img.fadeAlpha;
                bufferCtx.drawImage(img.img, img.x, img.y, img.w, img.h);
                bufferCtx.restore();
                // Request another frame to continue animation
                requestAnimationFrame(() => redraw());
            } else {
                // Animation complete
                fadeInImages.delete(img);
                img.fadeAlpha = 1;
                bufferCtx.drawImage(img.img, img.x, img.y, img.w, img.h);
            }
        } else {
            bufferCtx.drawImage(img.img, img.x, img.y, img.w, img.h);
        }
    }

    // 6. Draw Mask Chunks (if visible) onto Buffer
    if (maskVisible && !brushHidden) {
        bufferCtx.save();
        bufferCtx.globalAlpha = maskOpacity;
        maskChunks.forEach((chunk, key) => {
            const [cx, cy] = key.split(',').map(Number);
            bufferCtx.drawImage(chunk, cx * CHUNK_SIZE, cy * CHUNK_SIZE);
        });
        bufferCtx.restore();
    }

    // 7. Composite Buffer onto Main Canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bufferCanvas, 0, 0);

    // 8. Draw UI Overlays (Tile Selector / Brush)
    ctx.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);

    if (mode === "tile" && !isInferencing && !glowAnimationActive) {
        const tx = Math.round((mouseWorld.x - TILE_WIDTH / 2) / GRID_SIZE) * GRID_SIZE;
        const ty = Math.round((mouseWorld.y - TILE_HEIGHT / 2) / GRID_SIZE) * GRID_SIZE;
        ctx.strokeStyle = "#53B0C2";
        ctx.lineWidth = 1 / zoom;
        ctx.strokeRect(tx, ty, TILE_WIDTH, TILE_HEIGHT);
    }

    if (mode === "paint" && !isInferencing && !brushHidden) {
        // Use accent brush color from CSS variables if available
        let accent = '#762C41';
        try {
            const cssAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent-brush');
            if (cssAccent) accent = cssAccent.trim();
        } catch (err) {}
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1 / zoom, 1);
        ctx.beginPath();
        // Ensure radius uses world units; keep visible for all sizes
        ctx.arc(mouseWorld.x, mouseWorld.y, brushSize / 2, 0, Math.PI * 2);
        ctx.stroke();
    }

    // 8.5. Draw Placement Mode Preview
    if (placementMode && placementImage) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        // Snap preview to grid
        const imgX = Math.round((mouseWorld.x - placementImage.width / 2) / GRID_SIZE) * GRID_SIZE;
        const imgY = Math.round((mouseWorld.y - placementImage.height / 2) / GRID_SIZE) * GRID_SIZE;
        
        // Debug: Log snapping (uncomment to debug)
        // console.log(`Mouse: ${mouseWorld.x.toFixed(0)}, ${mouseWorld.y.toFixed(0)} -> Snapped: ${imgX}, ${imgY}`);
        
        ctx.drawImage(placementImage.img, imgX, imgY, placementImage.width, placementImage.height);
        
        // Draw border around placement preview
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#00d2ff";
        ctx.lineWidth = 3 / zoom;
        ctx.strokeRect(imgX, imgY, placementImage.width, placementImage.height);
        ctx.restore();
    }

    // 9. DYNAMIC INFERENCE TILE POSITIONING
    // This part ensures the orange frame moves and zooms with the canvas
    const activeTile = document.getElementById('active-inference-tile');
    if (activeTile) {
        const tx = parseFloat(activeTile.dataset.tx);
        const ty = parseFloat(activeTile.dataset.ty);
        const tw = parseFloat(activeTile.dataset.tw) || TILE_WIDTH;
        const th = parseFloat(activeTile.dataset.th) || TILE_HEIGHT;

        // Convert the world coordinates of the tile to screen coordinates
        const screenPos = worldToScreen(tx, ty);
        const scaledWidth = tw * zoom;
        const scaledHeight = th * zoom;

        // Update the CSS live so it stays "stuck" to the world
        Object.assign(activeTile.style, {
            left: `${screenPos.x}px`,
            top: `${screenPos.y}px`,
            width: `${scaledWidth}px`,
            height: `${scaledHeight}px`
        });
    }
}

// ---------- Inference Overlay ----------
function createInferenceTile(tx, ty, tw, th) {
    const tile = document.createElement('div');
    tile.className = 'inference-tile';
    tile.id = 'active-inference-tile';
    tile.dataset.tx = tx;
    tile.dataset.ty = ty;
    tile.dataset.tw = tw || TILE_WIDTH;
    tile.dataset.th = th || TILE_HEIGHT;

    const abortBtn = document.createElement('button');
    abortBtn.className = 'inference-abort';
    abortBtn.textContent = '✕'; 
    abortBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        abortInference();
    };

    // Progress bar container
    const progressContainer = document.createElement('div');
    progressContainer.className = 'inference-progress-container';
    progressContainer.id = 'inference-progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'inference-progress-bar';
    progressBar.id = 'inference-progress-bar';
    progressBar.style.width = '0%';
    
    progressContainer.appendChild(progressBar);

    // Status text
    const statusText = document.createElement('div');
    statusText.className = 'inference-status';
    statusText.id = 'inference-status-text';
    statusText.textContent = 'Generating...';

    tile.appendChild(abortBtn);
    tile.appendChild(progressContainer);
    tile.appendChild(statusText);
    document.body.appendChild(tile);
    
    return tile;
}

function updateInferenceStatus(text, percent = null) {
    const statusText = document.getElementById('inference-status-text');
    if (statusText) {
        statusText.textContent = text;
    }
    
    const progressBar = document.getElementById('inference-progress-bar');
    if (progressBar && percent !== null) {
        progressBar.style.width = `${percent}%`;
    }
}

function updateProgress(percentage, text) {
    const progressBar = document.getElementById('inference-progress-bar');
    const progressText = document.getElementById('inference-progress-text');
    
    if (progressBar && progressText) {
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = text || `${Math.round(percentage)}%`;
    }
}

function removeInferenceTile() {
    const tile = document.getElementById('active-inference-tile');
    if (tile) tile.remove();
    clearInferenceTimeout(); // Always clear timeout when removing tile
}

// Safety timeout functions to prevent stuck inference
function clearInferenceTimeout() {
    if (inferenceTimeout) {
        clearTimeout(inferenceTimeout);
        inferenceTimeout = null;
    }
}

function resetInferenceTimeout() {
    clearInferenceTimeout();
    // Timeout removed - tile will wait endlessly for inference completion
}

function abortInference() {
    clearInferenceTimeout(); // Clear timeout on abort
    if (currentPromptId) {
        fetch(`http://${COMFY_HOST}/interrupt`, { method: 'POST' })
            .then(() => {
                consoleLog.log("Inference aborted", "warning");
                isInferencing = false;
                currentPromptId = null;
                pendingInference = null;
                removeInferenceTile();
                showBrushAfterDelay();
                redraw();
            })
            .catch(err => {
                consoleLog.log(`Abort failed: ${err.message}`, "error");
            });
    }
}

// ---------- UI Handlers ----------
const modeBtn = document.getElementById("modeBtn");
modeBtn.onclick = () => {
    if (isInferencing) return;
    mode = (mode === "paint") ? "tile" : "paint";
    updateModeUI();
    redraw();
};

document.getElementById("saveBtn").onclick = () => {
    if (isInferencing) return;
    flattenImages();

    const temp = document.createElement("canvas");
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    images.forEach(img => {
        minX = Math.min(minX, img.x); minY = Math.min(minY, img.y);
        maxX = Math.max(maxX, img.x + img.w); maxY = Math.max(maxY, img.y + img.h);
    });
    if (images.length === 0) return;
    temp.width = maxX - minX; temp.height = maxY - minY;
    const tCtx = temp.getContext("2d");
    tCtx.translate(-minX, -minY);
    images.forEach(img => tCtx.drawImage(img.img, img.x, img.y, img.w, img.h));
    const link = document.createElement("a");
    link.download = "InfinityCanvas.png"; link.href = temp.toDataURL(); link.click();
    consoleLog.log("Canvas saved", "success");
};

const toggleMaskBtn = document.getElementById('toggleMaskBtn');
if (toggleMaskBtn) {
    toggleMaskBtn.onclick = () => {
        maskVisible = !maskVisible;
        toggleMaskBtn.textContent = maskVisible ? "👁️" : "🚫";
        redraw();
    };
}

// ---------- Tile Save & ComfyUI ----------
async function saveTileAsPNG(tx, ty) {
    if (isInferencing) return;
    isInferencing = true;
    
    // Hide brush during generation
    brushHidden = true;
    if (brushHideTimeout) {
        clearTimeout(brushHideTimeout);
        brushHideTimeout = null;
    }

    const tileWidth = TILE_WIDTH;
    const tileHeight = TILE_HEIGHT;

    createInferenceTile(tx, ty, tileWidth, tileHeight);
    updateInferenceStatus("Uploading..."); // SIMPLE STATUS
    redraw();

    const temp = document.createElement("canvas");
    temp.width = tileWidth;
    temp.height = tileHeight;
    const tCtx = temp.getContext("2d");

    tCtx.translate(-tx, -ty);
    
    images.forEach(img => tCtx.drawImage(img.img, img.x, img.y, img.w, img.h));

    tCtx.globalCompositeOperation = "destination-out";
    maskChunks.forEach((chunk, key) => {
        const [cx, cy] = key.split(',').map(Number);
        tCtx.drawImage(chunk, cx * CHUNK_SIZE, cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
    });

    temp.toBlob(async blob => {
            try {
                const fd = new FormData();
                const filename = `infinity_${Date.now()}.png`;
                fd.append("image", blob, filename);

                consoleLog.log("Uploading tile to ComfyUI...", "info");

                const up = await fetch(`http://${COMFY_HOST}/upload/image`, {
                    method: "POST",
                    body: fd
                });

                if (!up.ok) throw new Error(`Upload failed: ${up.status}`);

                const uploadResult = await up.json();
                const serverFilename = uploadResult.name;

                if (!window.activeWorkflow) throw new Error("No workflow synced from ComfyUI");

                updateInferenceStatus("Queuing..."); // SIMPLE STATUS

            // 4. Inject filename into the SPECIFIC LoadImage node titled 'input_tile'
            let workflow = JSON.parse(JSON.stringify(window.activeWorkflow));
            let tileNodeFound = false;

            console.log(`[SaveTile] Workflow nodes:`, Object.keys(workflow).length);
            
            for (let nodeId in workflow) {
                const node = workflow[nodeId];
                
                if (node.class_type === "LoadImage") {
                    console.log(`[SaveTile] Found LoadImage node ${nodeId}, title="${node._meta?.title}"`);
                }
                
                if (node.class_type === "LoadImage" && node._meta?.title === "input_tile") {
                    node.inputs.image = serverFilename;
                    tileNodeFound = true;
                    console.log(`[SaveTile] Injected into input_tile node ${nodeId}`);
                    break; 
                }
            }

            // Fallback: If 'input_tile' isn't found, find the first available LoadImage
            if (!tileNodeFound) {
                consoleLog.log("Node 'input_tile' not found, searching for any LoadImage node.", "warning");
                console.log(`[SaveTile] Searching for ANY LoadImage node...`);
                for (let nodeId in workflow) {
                    if (workflow[nodeId].class_type === "LoadImage") {
                        workflow[nodeId].inputs.image = serverFilename;
                        tileNodeFound = true;
                        console.log(`[SaveTile] Found LoadImage node ${nodeId}, injecting into it`);
                        break;
                    }
                }
            }

            if (!tileNodeFound) {
                consoleLog.log("No LoadImage node found - running workflow without tile injection.", "warning");
                console.log(`[SaveTile] NO LoadImage nodes found in workflow`);
            }

            // Store whether LoadImage node was found for later use
            window.hasLoadImageNode = tileNodeFound;
            console.log(`[SaveTile] Setting window.hasLoadImageNode = ${tileNodeFound}`);

            // 5. Inject custom prompt if provided
            const promptInput = document.getElementById('promptInput');
            const customPrompt = promptInput ? promptInput.value.trim() : '';
            
            if (customPrompt) {
                console.log(`[SaveTile] Custom prompt provided: "${customPrompt}"`);
                let promptNodeFound = false;
                
                // First try to find node titled 'input_text'
                for (let nodeId in workflow) {
                    const node = workflow[nodeId];
                    if ((node.class_type === "CLIPTextEncode" || node.class_type.includes("TextEncode")) && 
                        node._meta?.title === "input_text") {
                        if (node.inputs && node.inputs.text !== undefined) {
                            node.inputs.text = customPrompt;
                            promptNodeFound = true;
                            console.log(`[SaveTile] Injected prompt into input_text node ${nodeId}`);
                            consoleLog.log(`Using custom prompt: "${customPrompt.substring(0, 50)}..."`, "info");
                            break;
                        }
                    }
                }
                
                // Fallback: Find text encoder connected to positive input of a sampler
                if (!promptNodeFound) {
                    console.log(`[SaveTile] No input_text node found, searching for sampler connection...`);
                    
                    // Find all sampler nodes
                    const samplerNodes = [];
                    for (let nodeId in workflow) {
                        const node = workflow[nodeId];
                        if (node.class_type && (
                            node.class_type.includes("Sampler") || 
                            node.class_type === "KSampler" || 
                            node.class_type === "KSamplerAdvanced"
                        )) {
                            samplerNodes.push({ id: nodeId, node: node });
                        }
                    }
                    
                    // For each sampler, trace back to find text encoder on positive input
                    for (const { id: samplerId, node: samplerNode } of samplerNodes) {
                        if (samplerNode.inputs && samplerNode.inputs.positive) {
                            const positiveInput = samplerNode.inputs.positive;
                            
                            // Check if it's a node connection [nodeId, outputIndex]
                            if (Array.isArray(positiveInput) && positiveInput.length >= 1) {
                                const connectedNodeId = positiveInput[0];
                                const connectedNode = workflow[connectedNodeId];
                                
                                if (connectedNode && (
                                    connectedNode.class_type === "CLIPTextEncode" || 
                                    connectedNode.class_type.includes("TextEncode")
                                )) {
                                    if (connectedNode.inputs && connectedNode.inputs.text !== undefined) {
                                        connectedNode.inputs.text = customPrompt;
                                        promptNodeFound = true;
                                        console.log(`[SaveTile] Injected prompt into connected text encoder ${connectedNodeId}`);
                                        consoleLog.log(`Using custom prompt: "${customPrompt.substring(0, 50)}..."`, "info");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                
                if (!promptNodeFound) {
                    consoleLog.log("Warning: No suitable text encoder node found for prompt override", "warning");
                    console.log(`[SaveTile] Could not find text encoder node for prompt injection`);
                }
            }

            updateInferenceStatus("Generating..."); // SIMPLE STATUS
            
            const response = await fetch(`http://${COMFY_HOST}/prompt`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: workflow })
            });

            const result = await response.json();
            
            if (!response.ok) {
                // Extract detailed error information from ComfyUI
                let errorMessage = `Prompt failed: ${response.status}`;
                if (result.error) {
                    errorMessage = result.error;
                    if (result.node_errors) {
                        const nodeErrors = Object.entries(result.node_errors)
                            .map(([nodeId, error]) => `Node ${nodeId}: ${error.class_type} - ${error.errors?.[0]?.message || JSON.stringify(error)}`)
                            .join('\n');
                        errorMessage += '\n' + nodeErrors;
                    }
                }
                throw new Error(errorMessage);
            }

            if (result.prompt_id) {
                currentPromptId = result.prompt_id;
                pendingInference = { tx, ty };
                receivedProgressThisInference = false; // Reset progress flag for new inference
                lastProgressTime = Date.now();
                resetInferenceTimeout(); // Start safety timeout
                consoleLog.log(`Inference queued: ${result.prompt_id}`, "success");
                // WebSocket will handle progress updates
            }
        } catch (err) {
            console.error("Full error:", err);
            consoleLog.log(`Error: ${err.message}`, "error");
            isInferencing = false;
            currentPromptId = null;
            pendingInference = null;
            removeInferenceTile();
            showBrushAfterDelay();
            redraw();
        }
    }, "image/png");
}




function processInferenceResult(imgInfo, tx, ty, hasLoadImageNode = true) {
    const activeTile = document.getElementById('active-inference-tile');
    const tileWidth = activeTile ? parseFloat(activeTile.dataset.tw) : TILE_WIDTH;
    const tileHeight = activeTile ? parseFloat(activeTile.dataset.th) : TILE_HEIGHT;
    
    console.log(`[Process] hasLoadImageNode=${hasLoadImageNode}, tileWidth=${tileWidth}, tileHeight=${tileHeight}`);
    
    const url = `http://${COMFY_HOST}/view?filename=${imgInfo.filename}&type=${imgInfo.type}&subfolder=${imgInfo.subfolder || ''}&t=${Date.now()}`;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        console.log(`[Process] Image loaded: ${img.naturalWidth}x${img.naturalHeight}`);
        // If no LoadImage node was found, paste at true size (not scaled)
        if (!hasLoadImageNode) {
            const imgWidth = img.naturalWidth;
            const imgHeight = img.naturalHeight;
            
            // Create canvas at the image's true size
            const resultCanvas = document.createElement("canvas");
            resultCanvas.width = imgWidth;
            resultCanvas.height = imgHeight;
            const rCtx = resultCanvas.getContext("2d");
            
            // Draw the image at its true size
            rCtx.drawImage(img, 0, 0);
            
            saveUndoState();
            const newImg = {
                img: resultCanvas,
                x: tx, y: ty,
                w: imgWidth, h: imgHeight
            };
            images.push(newImg);
            addImageWithFade(newImg);
            
            // Trigger effects
            triggerGlowFlash(tx, ty, imgWidth, imgHeight);
            createParticles(tx + imgWidth / 2, ty + imgHeight / 2);
            
            consoleLog.log(`Inference complete: Image pasted at true size (${imgWidth}x${imgHeight})`, "success");
        } else {
            // Original behavior: use mask-based composition
            const resultCanvas = document.createElement("canvas");
            resultCanvas.width = tileWidth;
            resultCanvas.height = tileHeight;
            const rCtx = resultCanvas.getContext("2d");

            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = tileWidth;
            maskCanvas.height = tileHeight;
            const mCtx = maskCanvas.getContext("2d");

            maskChunks.forEach((chunk, key) => {
                const [cx, cy] = key.split(',').map(Number);
                mCtx.drawImage(chunk, cx * CHUNK_SIZE - tx, cy * CHUNK_SIZE - ty);
            });

            const existingImgCanvas = document.createElement('canvas');
            existingImgCanvas.width = tileWidth;
            existingImgCanvas.height = tileHeight;
            const eiCtx = existingImgCanvas.getContext('2d');

            images.forEach(imgObj => {
                eiCtx.drawImage(imgObj.img, imgObj.x - tx, imgObj.y - ty, imgObj.w, imgObj.h);
            });

            mCtx.globalCompositeOperation = 'destination-over';
            const holeCanvas = document.createElement('canvas');
            holeCanvas.width = tileWidth;
            holeCanvas.height = tileHeight;
            const hCtx = holeCanvas.getContext('2d');
            hCtx.fillStyle = "white";
            hCtx.fillRect(0, 0, tileWidth, tileHeight);
            hCtx.globalCompositeOperation = 'destination-out';
            hCtx.drawImage(existingImgCanvas, 0, 0);
            mCtx.drawImage(holeCanvas, 0, 0);

            rCtx.drawImage(maskCanvas, 0, 0);
            rCtx.globalCompositeOperation = "source-in";
            rCtx.drawImage(img, 0, 0, tileWidth, tileHeight);

            saveUndoState();
            const newImg = {
                img: resultCanvas,
                x: tx, y: ty,
                w: tileWidth, h: tileHeight
            };
            images.push(newImg);
            addImageWithFade(newImg);

            // Trigger effects
            triggerGlowFlash(tx, ty, tileWidth, tileHeight);
            createParticles(tx + tileWidth / 2, ty + tileHeight / 2);

            consoleLog.log("Inference complete: Image pasted.", "success");
        }

        isInferencing = false;
        currentPromptId = null;
        pendingInference = null;
        removeInferenceTile();
        flattenImages();
        showBrushAfterDelay();
        redraw();
    };
    img.onerror = () => {
        consoleLog.log("Failed to load generated image", "error");
        isInferencing = false;
        currentPromptId = null;
        pendingInference = null;
        removeInferenceTile();
        showBrushAfterDelay();
        redraw();
    };
    img.src = url;
}

function deleteImagesAtTile(tx, ty, skipUndo = false, skipLog = false) {
    if (!skipUndo) saveUndoState();
    const tileW = TILE_WIDTH;
    const tileH = TILE_HEIGHT;

    images.forEach(imgObj => {
        if (!(imgObj.img instanceof HTMLCanvasElement)) {
            const offscreen = document.createElement("canvas");
            offscreen.width = imgObj.img.naturalWidth || imgObj.w;
            offscreen.height = imgObj.img.naturalHeight || imgObj.h;
            const offCtx = offscreen.getContext("2d");
            offCtx.drawImage(imgObj.img, 0, 0);
            imgObj.img = offscreen;
        }

        const xOverlap = Math.max(imgObj.x, tx);
        const yOverlap = Math.max(imgObj.y, ty);
        const wOverlap = Math.min(imgObj.x + imgObj.w, tx + tileW) - xOverlap;
        const hOverlap = Math.min(imgObj.y + imgObj.h, ty + tileH) - yOverlap;

        if (wOverlap > 0 && hOverlap > 0) {
            const ictx = imgObj.img.getContext("2d");
            const localX = xOverlap - imgObj.x;
            const localY = yOverlap - imgObj.y;
            ictx.globalCompositeOperation = "destination-out";
            ictx.fillRect(localX, localY, wOverlap, hOverlap);
            ictx.globalCompositeOperation = "source-over";
        }
    });

    if (!skipLog) {
        consoleLog.log("Tile area erased", "info");
    }
    redraw();
}

function updateModeUI() {
    const modeBtn = document.getElementById("modeBtn");
    const brushGroup = document.getElementById("brushGroup");
    const tileSizeGroup = document.getElementById("tileSizeGroup");

    // Remove all mode classes first
    if (modeBtn) {
        modeBtn.classList.remove("brush-mode", "tile-mode", "pan-mode");
    }

    if (mode === "paint") {
        modeBtn.textContent = "🖌️ BRUSH MODE";
        if (modeBtn) modeBtn.classList.add("brush-mode");
        if (brushGroup) brushGroup.style.display = "flex";
        if (tileSizeGroup) tileSizeGroup.style.display = "none";
        canvas.style.cursor = "crosshair";
    } else if (mode === "tile") {
        modeBtn.textContent = "🎯 TILE MODE";
        if (modeBtn) modeBtn.classList.add("tile-mode");
        if (brushGroup) brushGroup.style.display = "none";
        if (tileSizeGroup) tileSizeGroup.style.display = "flex";
        canvas.style.cursor = "crosshair";
    } else if (mode === "pan") {
        if (modeBtn) modeBtn.classList.add("pan-mode");
        canvas.style.cursor = "grab";
    }
}

const sizeSelector = document.getElementById("sizeSelector");
if (sizeSelector) {
    sizeSelector.onchange = (e) => {
        const size = parseInt(e.target.value);
        TILE_WIDTH = size;
        TILE_HEIGHT = size;
        consoleLog.log(`Tile size: ${size}×${size}px`, "info");
        redraw();
    };
}

// Custom size checkbox
const customSizeCheckbox = document.getElementById("customSizeCheckbox");
const customWidth = document.getElementById("customWidth");
const customHeight = document.getElementById("customHeight");

if (customSizeCheckbox) {
    customSizeCheckbox.onchange = (e) => {
        const isCustom = e.target.checked;
        
        // Toggle disabled state and visual styling
        if (sizeSelector) {
            sizeSelector.disabled = isCustom;
            sizeSelector.style.opacity = isCustom ? "0.5" : "1";
        }
        if (customWidth) {
            customWidth.disabled = !isCustom;
            customWidth.style.opacity = isCustom ? "1" : "0.5";
        }
        if (customHeight) {
            customHeight.disabled = !isCustom;
            customHeight.style.opacity = isCustom ? "1" : "0.5";
        }
        
        // Update tile dimensions
        if (isCustom) {
            TILE_WIDTH = parseInt(customWidth.value) || 512;
            TILE_HEIGHT = parseInt(customHeight.value) || 768;
            consoleLog.log(`Custom tile size: ${TILE_WIDTH}×${TILE_HEIGHT}px`, "info");
        } else {
            const size = parseInt(sizeSelector.value);
            TILE_WIDTH = size;
            TILE_HEIGHT = size;
            consoleLog.log(`Tile size: ${size}×${size}px`, "info");
        }
        redraw();
    };
    // Make custom size selected by default on load
    try {
        customSizeCheckbox.checked = true;
        customSizeCheckbox.dispatchEvent(new Event('change'));
    } catch (err) {
        console.warn('Failed to set default custom size checkbox:', err);
    }
}

// Custom size inputs

if (customWidth) {
    customWidth.oninput = (e) => {
        const width = parseInt(e.target.value) || 512;
        TILE_WIDTH = Math.max(64, Math.min(4096, width));
        consoleLog.log(`Tile width: ${TILE_WIDTH}px`, "info");
        redraw();
    };
}

if (customHeight) {
    customHeight.oninput = (e) => {
        const height = parseInt(e.target.value) || 768;
        TILE_HEIGHT = Math.max(64, Math.min(4096, height));
        consoleLog.log(`Tile height: ${TILE_HEIGHT}px`, "info");
        redraw();
    };
}

// ---------- Keyboard Handlers ----------

// Clipboard paste support - paste images from Photoshop, browsers, screenshots, etc.
window.addEventListener("paste", e => {
    if (isInferencing) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            
            const blob = item.getAsFile();
            if (!blob) continue;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    // Convert to canvas for consistency
                    const imgCanvas = document.createElement("canvas");
                    imgCanvas.width = img.naturalWidth;
                    imgCanvas.height = img.naturalHeight;
                    const imgCtx = imgCanvas.getContext("2d");
                    imgCtx.drawImage(img, 0, 0);
                    
                    // Enter placement mode
                    placementMode = true;
                    placementImage = {
                        img: imgCanvas,
                        width: img.naturalWidth,
                        height: img.naturalHeight
                    };
                    canvas.style.cursor = "copy";
                    consoleLog.log(`Image pasted (${img.naturalWidth}×${img.naturalHeight}) - click to place`, "success");
                    redraw();
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(blob);
            return; // Only handle first image
        }
    }
});

window.addEventListener("keydown", e => {
    if (isInferencing && e.key.toLowerCase() !== 'escape') return;

    const key = e.key.toLowerCase();
    
    // Check if user is typing in an input field
    const activeElement = document.activeElement;
    const isTyping = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');

    // Cancel placement mode with ESC
    if (key === 'escape' && placementMode) {
        placementMode = false;
        placementImage = null;
        canvas.style.cursor = mode === 'paint' ? 'crosshair' : 'default';
        consoleLog.log("Placement cancelled", "info");
        redraw();
        return;
    }

    // Redo
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z') {
        e.preventDefault();
        performRedo();
        return;
    }

    // Undo
    if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
        return;
    }

    // Copy to clipboard (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && key === 'c') {
        e.preventDefault();
        copyToClipboard();
        return;
    }

    // Toggle mask visibility - skip if typing
    if (key === 'z' && !e.ctrlKey && !e.metaKey && !isTyping) {
        maskVisible = !maskVisible;
        const toggleBtn = document.getElementById('toggleMaskBtn');
        if (toggleBtn) {
            toggleBtn.textContent = maskVisible ? "👁️" : "🚫";
        }
        consoleLog.log(`Mask ${maskVisible ? 'visible' : 'hidden'}`, "info");
        redraw();
    }

    // Toggle toolbar visibility (hide all except info button) - skip if typing
    if (key === 'h' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !isTyping) {
        const buttonRow = document.querySelector('.button-row');
        if (buttonRow) {
            buttonRow.classList.toggle('toolbar-hidden');
            const isHidden = buttonRow.classList.contains('toolbar-hidden');
            consoleLog.log(`Toolbar ${isHidden ? 'hidden' : 'visible'}`, "info");
        }
    }

    // Toggle mode - skip if typing
    if (key === 'x' && !isTyping) {
        if (isInferencing) return;
        mode = (mode === "paint") ? "tile" : "paint";
        updateModeUI();
        consoleLog.log(`Mode: ${mode}`, "info");
        redraw();
    }

    // Abort inference
    if (key === 'escape') {
        if (isInferencing) {
            abortInference();
        }
    }

    // Pan mode (hold space) - allow during placement mode
    if (e.code === "Space" && !isInferencing && mode !== "pan" && !isTyping) {
        e.preventDefault();
        mode = "pan";
        canvas.style.cursor = "grab";
    }
});

window.addEventListener("keyup", e => {
    if (e.code === "Space" && mode === "pan") {
        mode = "paint";
        // Restore cursor appropriately
        if (placementMode) {
            canvas.style.cursor = "crosshair";
        } else {
            updateModeUI();
        }
        redraw();
    }
});

// ---------- Helper Functions ----------
function screenToWorld(sx, sy) {
    return { x: (sx - offsetX) / zoom, y: (sy - offsetY) / zoom };
}

function worldToScreen(wx, wy) {
    return { x: wx * zoom + offsetX, y: wy * zoom + offsetY };
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

// ----- drag

let dragPreview = null;

function ensureDragPreview() {
    dragPreview = document.getElementById('drag-preview');
    if (!dragPreview) {
        dragPreview = document.createElement('div');
        dragPreview.id = 'drag-preview';
        document.body.appendChild(dragPreview);
    }
}

window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();

    ensureDragPreview();

    // Use TILE_WIDTH for the preview box (assuming square for preview)
    const visualSize = TILE_WIDTH * zoom;

    dragPreview.style.display = 'block';
    dragPreview.style.width = `${visualSize}px`;
    dragPreview.style.height = `${visualSize}px`;

    // Centers the box on your cursor
    dragPreview.style.left = `${e.clientX - visualSize / 2}px`;
    dragPreview.style.top = `${e.clientY - visualSize / 2}px`;

    e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget && dragPreview) dragPreview.style.display = 'none';
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (dragPreview) dragPreview.style.display = 'none';

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    // Enter placement mode instead of immediately placing
                    placementMode = true;
                    placementImage = {
                        img: img,
                        width: img.width,
                        height: img.height
                    };
                    canvas.style.cursor = 'crosshair';
                    consoleLog.log(`Placement mode: ${img.width}x${img.height} - Click to place`, "info");
                    redraw();
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }
    }
});

// ---------- Initialize ----------
DOM.init(); // Cache all DOM references
consoleLog.init();
updateModeUI();
consoleLog.log("Infinity Canvas initialized", "success");